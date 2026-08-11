-- Connector registry
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

-- Per-tenant connector instances
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

-- Sync jobs
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

-- Seed built-in connectors
INSERT INTO public.connectors (connector_type, label, auth_type, config_schema) VALUES
  ('odoo', 'Odoo ERP', 'basic', '{"type":"object","properties":{"url":{"type":"string","title":"Odoo URL"},"database":{"type":"string","title":"Database"},"username":{"type":"string","title":"Username"},"password":{"type":"string","title":"Password / API Key"}},"required":["url","database","username","password"]}'),
  ('generic-rest', 'Generic REST API', 'api_key', '{"type":"object","properties":{"base_url":{"type":"string","title":"Base URL"},"api_key":{"type":"string","title":"API Key"},"products_endpoint":{"type":"string","title":"Products Endpoint"},"invoices_endpoint":{"type":"string","title":"Invoices Endpoint"},"stock_endpoint":{"type":"string","title":"Stock Endpoint"}},"required":["base_url","api_key"]}'),
  ('generic-webhook', 'Custom Webhook (Push)', 'custom', '{"type":"object","properties":{"webhook_secret":{"type":"string","title":"Webhook Secret"},"webhook_url":{"type":"string","title":"Webhook URL"}},"required":["webhook_secret"]}')
ON CONFLICT (connector_type) DO NOTHING;
