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