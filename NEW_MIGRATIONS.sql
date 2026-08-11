-- NEW MIGRATIONS: Run this in Supabase SQL Editor
-- https://supabase.com/dashboard/project/tbmxftizqqwoycqvtgcv/sql/new

-- ============================================================
-- Migration 1: API token expiry + audit logs
-- ============================================================

ALTER TABLE public.api_tokens ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
UPDATE public.api_tokens SET expires_at = NULL WHERE expires_at IS NULL;

CREATE TABLE IF NOT EXISTS public.audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES public.tenants(id),
  actor_id UUID,
  actor_email TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  ip_address TEXT,
  user_agent TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.audit_logs TO service_role;
CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant ON public.audit_logs(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON public.audit_logs(actor_id, created_at DESC);

-- ============================================================
-- Migration 2: Connectors + sync jobs
-- ============================================================

CREATE TABLE IF NOT EXISTS public.connectors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_type TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  auth_type TEXT NOT NULL,
  config_schema JSONB NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.connectors ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.connectors TO service_role;

CREATE TABLE IF NOT EXISTS public.tenant_connectors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  connector_type TEXT NOT NULL,
  config_encrypted TEXT NOT NULL,
  sync_mode TEXT NOT NULL DEFAULT 'auto',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, connector_type)
);
ALTER TABLE public.tenant_connectors ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.tenant_connectors TO service_role;

CREATE TABLE IF NOT EXISTS public.sync_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  connector_type TEXT NOT NULL,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  payload JSONB,
  result JSONB,
  error TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.sync_jobs ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.sync_jobs TO service_role;
CREATE INDEX IF NOT EXISTS idx_sync_jobs_tenant ON public.sync_jobs(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_jobs_status ON public.sync_jobs(status) WHERE status = 'pending';

INSERT INTO public.connectors (connector_type, label, auth_type, config_schema) VALUES
  ('odoo', 'Odoo ERP', 'basic', '{"type":"object","properties":{"url":{"type":"string","title":"Odoo URL"},"database":{"type":"string","title":"Database"},"username":{"type":"string","title":"Username"},"password":{"type":"string","title":"Password / API Key"}},"required":["url","database","username","password"]}'),
  ('generic-rest', 'Generic REST API', 'api_key', '{"type":"object","properties":{"base_url":{"type":"string","title":"Base URL"},"api_key":{"type":"string","title":"API Key"},"products_endpoint":{"type":"string","title":"Products Endpoint"},"invoices_endpoint":{"type":"string","title":"Invoices Endpoint"},"stock_endpoint":{"type":"string","title":"Stock Endpoint"}},"required":["base_url","api_key"]}'),
  ('generic-webhook', 'Custom Webhook (Push)', 'custom', '{"type":"object","properties":{"webhook_secret":{"type":"string","title":"Webhook Secret"},"webhook_url":{"type":"string","title":"Webhook URL"}},"required":["webhook_secret"]}')
ON CONFLICT (connector_type) DO NOTHING;

-- ============================================================
-- Migration 3: Recipes / BOM
-- ============================================================

CREATE TABLE IF NOT EXISTS public.recipes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  finished_product_code TEXT NOT NULL,
  finished_product_name TEXT NOT NULL,
  conversion_factor NUMERIC NOT NULL DEFAULT 1.0,
  unit_of_measure TEXT NOT NULL DEFAULT 'unit',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, finished_product_code)
);
ALTER TABLE public.recipes ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.recipes TO service_role;

CREATE TABLE IF NOT EXISTS public.recipe_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id UUID NOT NULL REFERENCES public.recipes(id) ON DELETE CASCADE,
  raw_material_code TEXT NOT NULL,
  raw_material_name TEXT NOT NULL,
  quantity_per_unit NUMERIC NOT NULL,
  unit_of_measure TEXT NOT NULL DEFAULT 'kg',
  waste_factor NUMERIC NOT NULL DEFAULT 0.0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.recipe_items ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.recipe_items TO service_role;
CREATE INDEX IF NOT EXISTS idx_recipes_tenant ON public.recipes(tenant_id);
CREATE INDEX IF NOT EXISTS idx_recipe_items_recipe ON public.recipe_items(recipe_id);

-- ============================================================
-- Migration 4: Billing + Fraud detection
-- ============================================================

CREATE TABLE IF NOT EXISTS public.store_billing (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id UUID NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  billing_period TEXT NOT NULL,
  amount_mwk NUMERIC NOT NULL DEFAULT 30000,
  status TEXT NOT NULL DEFAULT 'pending',
  paid_at TIMESTAMPTZ,
  payment_reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(store_id, billing_period)
);
ALTER TABLE public.store_billing ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.store_billing TO service_role;
CREATE INDEX IF NOT EXISTS idx_store_billing_tenant ON public.store_billing(tenant_id, billing_period);

CREATE TABLE IF NOT EXISTS public.fraud_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  store_id UUID,
  terminal_id UUID,
  invoice_id UUID,
  rule_id TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium',
  description TEXT NOT NULL,
  evidence JSONB,
  status TEXT NOT NULL DEFAULT 'open',
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.fraud_alerts ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.fraud_alerts TO service_role;
CREATE INDEX IF NOT EXISTS idx_fraud_alerts_tenant ON public.fraud_alerts(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fraud_alerts_status ON public.fraud_alerts(status) WHERE status = 'open';
