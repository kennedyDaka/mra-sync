-- helper
CREATE TABLE public.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  taxpayer_tin text,
  mode text NOT NULL DEFAULT 'test' CHECK (mode IN ('test','live')),
  rate_limit_per_min integer NOT NULL DEFAULT 300,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenants TO authenticated;
GRANT ALL ON public.tenants TO service_role;
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owners manage tenants" ON public.tenants FOR ALL TO authenticated
  USING (owner_user_id = auth.uid()) WITH CHECK (owner_user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.owns_tenant(_tenant_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = _tenant_id AND t.owner_user_id = auth.uid());
$$;

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE TRIGGER trg_tenants_touch BEFORE UPDATE ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- terminals
CREATE TABLE public.terminals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  store_id text NOT NULL,
  terminal_id text NOT NULL,
  mra_terminal_ref text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended','error')),
  activated_at timestamptz,
  last_config_sync_at timestamptz,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  invoice_sequence bigint NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, terminal_id)
);
CREATE INDEX idx_terminals_tenant ON public.terminals(tenant_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.terminals TO authenticated;
GRANT ALL ON public.terminals TO service_role;
ALTER TABLE public.terminals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owners manage terminals" ON public.terminals FOR ALL TO authenticated
  USING (public.owns_tenant(tenant_id)) WITH CHECK (public.owns_tenant(tenant_id));
CREATE TRIGGER trg_terminals_touch BEFORE UPDATE ON public.terminals
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- encrypted credentials (backend only)
CREATE TABLE public.terminal_secrets (
  terminal_uid uuid PRIMARY KEY REFERENCES public.terminals(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  access_key_enc text NOT NULL,
  secret_key_enc text NOT NULL,
  session_token_enc text,
  session_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.terminal_secrets TO service_role;
ALTER TABLE public.terminal_secrets ENABLE ROW LEVEL SECURITY;

-- ERP api tokens
CREATE TABLE public.api_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  label text NOT NULL DEFAULT 'default',
  token_hash text NOT NULL UNIQUE,
  token_prefix text NOT NULL,
  revoked boolean NOT NULL DEFAULT false,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_api_tokens_tenant ON public.api_tokens(tenant_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.api_tokens TO authenticated;
GRANT ALL ON public.api_tokens TO service_role;
ALTER TABLE public.api_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owners manage api tokens" ON public.api_tokens FOR ALL TO authenticated
  USING (public.owns_tenant(tenant_id)) WITH CHECK (public.owns_tenant(tenant_id));

-- product mappings
CREATE TABLE public.product_maps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  local_sku text NOT NULL,
  mra_product_id text,
  description text,
  product_type text NOT NULL DEFAULT 'product' CHECK (product_type IN ('product','service')),
  tax_category text NOT NULL DEFAULT 'STANDARD',
  unit_of_measure text,
  quantity_on_hand numeric(18,3),
  informal_purchase boolean NOT NULL DEFAULT false,
  auto_registered boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, local_sku)
);
CREATE INDEX idx_product_maps_tenant ON public.product_maps(tenant_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_maps TO authenticated;
GRANT ALL ON public.product_maps TO service_role;
ALTER TABLE public.product_maps ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owners manage product maps" ON public.product_maps FOR ALL TO authenticated
  USING (public.owns_tenant(tenant_id)) WITH CHECK (public.owns_tenant(tenant_id));
CREATE TRIGGER trg_product_maps_touch BEFORE UPDATE ON public.product_maps
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- invoices
CREATE TABLE public.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  terminal_uid uuid REFERENCES public.terminals(id) ON DELETE SET NULL,
  erp_invoice_number text NOT NULL,
  idempotency_key text,
  cashier_id text,
  customer_tin text,
  status text NOT NULL DEFAULT 'PENDING_SYNC'
    CHECK (status IN ('PENDING_SYNC','QUEUED','SUBMITTED','FAILED','REJECTED')),
  is_offline boolean NOT NULL DEFAULT false,
  erp_payload jsonb NOT NULL,
  mra_payload jsonb,
  mra_response jsonb,
  mra_invoice_id text,
  signature text,
  qr_payload text,
  invoice_sequence bigint,
  total_vat numeric(18,2) NOT NULL DEFAULT 0,
  grand_total numeric(18,2) NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, erp_invoice_number)
);
CREATE INDEX idx_invoices_tenant_created ON public.invoices(tenant_id, created_at DESC);
CREATE INDEX idx_invoices_status ON public.invoices(status);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.invoices TO authenticated;
GRANT ALL ON public.invoices TO service_role;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owners manage invoices" ON public.invoices FOR ALL TO authenticated
  USING (public.owns_tenant(tenant_id)) WITH CHECK (public.owns_tenant(tenant_id));
CREATE TRIGGER trg_invoices_touch BEFORE UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- FIFO sync queue
CREATE TABLE public.sync_queue (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','done','dead')),
  attempts integer NOT NULL DEFAULT 0,
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_id)
);
CREATE INDEX idx_sync_queue_pick ON public.sync_queue(status, run_after, id);
GRANT SELECT, DELETE ON public.sync_queue TO authenticated;
GRANT ALL ON public.sync_queue TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.sync_queue_id_seq TO service_role;
ALTER TABLE public.sync_queue ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owners read queue" ON public.sync_queue FOR SELECT TO authenticated
  USING (public.owns_tenant(tenant_id));
CREATE POLICY "owners delete queue" ON public.sync_queue FOR DELETE TO authenticated
  USING (public.owns_tenant(tenant_id));

-- rate limiting
CREATE TABLE public.rate_limit_buckets (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  tokens numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.rate_limit_buckets TO service_role;
ALTER TABLE public.rate_limit_buckets ENABLE ROW LEVEL SECURITY;

-- outbound request log
CREATE TABLE public.mra_logs (
  id bigserial PRIMARY KEY,
  tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE,
  terminal_uid uuid,
  endpoint text NOT NULL,
  status_code integer,
  duration_ms integer,
  ok boolean NOT NULL DEFAULT false,
  request_body text,
  response_body text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_mra_logs_tenant ON public.mra_logs(tenant_id, created_at DESC);
GRANT SELECT ON public.mra_logs TO authenticated;
GRANT ALL ON public.mra_logs TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.mra_logs_id_seq TO service_role;
ALTER TABLE public.mra_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owners read logs" ON public.mra_logs FOR SELECT TO authenticated
  USING (public.owns_tenant(tenant_id));

-- atomic token-bucket rate limiter
CREATE OR REPLACE FUNCTION public.consume_rate_token(_tenant_id uuid, _capacity numeric, _refill_per_sec numeric)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  cur numeric; last timestamptz; elapsed numeric;
BEGIN
  INSERT INTO public.rate_limit_buckets(tenant_id, tokens, updated_at)
  VALUES (_tenant_id, _capacity, now())
  ON CONFLICT (tenant_id) DO NOTHING;

  SELECT tokens, updated_at INTO cur, last
  FROM public.rate_limit_buckets WHERE tenant_id = _tenant_id FOR UPDATE;

  elapsed := EXTRACT(EPOCH FROM (now() - last));
  cur := LEAST(_capacity, cur + elapsed * _refill_per_sec);

  IF cur < 1 THEN
    UPDATE public.rate_limit_buckets SET tokens = cur, updated_at = now() WHERE tenant_id = _tenant_id;
    RETURN false;
  END IF;

  UPDATE public.rate_limit_buckets SET tokens = cur - 1, updated_at = now() WHERE tenant_id = _tenant_id;
  RETURN true;
END; $$;

-- FIFO claim with row locking
CREATE OR REPLACE FUNCTION public.claim_sync_jobs(_limit integer)
RETURNS SETOF public.sync_queue LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.sync_queue q
  SET status = 'processing', locked_at = now(), attempts = q.attempts + 1
  WHERE q.id IN (
    SELECT id FROM public.sync_queue
    WHERE status = 'queued' AND run_after <= now()
    ORDER BY id ASC
    LIMIT _limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
$$;

REVOKE ALL ON FUNCTION public.consume_rate_token(uuid, numeric, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_sync_jobs(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_rate_token(uuid, numeric, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_sync_jobs(integer) TO service_role;