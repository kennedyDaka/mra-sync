-- Migration: 20260808063754_4c7479b5-61ae-4442-b2f4-b046cbf4b19c.sql
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

-- Migration: 20260808063805_62c45a4e-81f4-4e93-88b6-dfed007c2631.sql
REVOKE ALL ON FUNCTION public.owns_tenant(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.owns_tenant(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.touch_updated_at() FROM PUBLIC, anon, authenticated;

-- Migration: 20260808063846_a873dc5e-f059-48aa-a888-2eb377c979c0.sql
CREATE OR REPLACE FUNCTION public.next_invoice_sequence(_terminal_uid uuid)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE nxt bigint;
BEGIN
  UPDATE public.terminals SET invoice_sequence = invoice_sequence + 1
  WHERE id = _terminal_uid
  RETURNING invoice_sequence INTO nxt;
  RETURN nxt;
END; $$;
REVOKE ALL ON FUNCTION public.next_invoice_sequence(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.next_invoice_sequence(uuid) TO service_role;

-- Migration: 20260809060714_6a5db7e7-a4d7-4460-af68-7a4183d4aa23.sql
ALTER TABLE public.terminals
  ADD COLUMN IF NOT EXISTS taxpayer_id bigint,
  ADD COLUMN IF NOT EXISTS terminal_position integer,
  ADD COLUMN IF NOT EXISTS activation_code text,
  ADD COLUMN IF NOT EXISTS global_config_version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS taxpayer_config_version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS terminal_config_version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_blocked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS blocking_message text,
  ADD COLUMN IF NOT EXISTS offline_max_age_hours numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS offline_max_amount numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS offline_accumulated numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS mra_invoice_number text,
  ADD COLUMN IF NOT EXISTS validation_url text,
  ADD COLUMN IF NOT EXISTS offline_signature text,
  ADD COLUMN IF NOT EXISTS transaction_count bigint;

ALTER TABLE public.product_maps
  ADD COLUMN IF NOT EXISTS tax_rate_id text;

-- Migration: 20260811020935_3031a0f6-82b5-433f-baf1-c6fb50524f39.sql
CREATE TABLE public.stores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  address text,
  mra_site_id text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.stores TO authenticated;
GRANT ALL ON public.stores TO service_role;

ALTER TABLE public.stores ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owners manage stores" ON public.stores
  FOR ALL TO authenticated
  USING (public.owns_tenant(tenant_id))
  WITH CHECK (public.owns_tenant(tenant_id));

CREATE TRIGGER trg_stores_touch BEFORE UPDATE ON public.stores
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.terminals ADD COLUMN store_uid uuid REFERENCES public.stores(id) ON DELETE SET NULL;

INSERT INTO public.stores (tenant_id, code, name)
SELECT DISTINCT t.tenant_id, t.store_id, t.store_id
FROM public.terminals t
ON CONFLICT (tenant_id, code) DO NOTHING;

UPDATE public.terminals t
SET store_uid = s.id
FROM public.stores s
WHERE s.tenant_id = t.tenant_id AND s.code = t.store_id;

CREATE INDEX idx_terminals_store_uid ON public.terminals(store_uid);
CREATE INDEX idx_stores_tenant ON public.stores(tenant_id);

-- Migration: 20260811020950_47172905-4c76-4c62-b6aa-e11822cf5762.sql
REVOKE EXECUTE ON FUNCTION public.claim_sync_jobs(integer) FROM authenticated, anon, public;
REVOKE EXECUTE ON FUNCTION public.consume_rate_token(uuid, numeric, numeric) FROM authenticated, anon, public;
REVOKE EXECUTE ON FUNCTION public.next_invoice_sequence(uuid) FROM authenticated, anon, public;

GRANT EXECUTE ON FUNCTION public.claim_sync_jobs(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_rate_token(uuid, numeric, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.next_invoice_sequence(uuid) TO service_role;

