-- Multi-store billing (MWK 30,000 per store)
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

-- Fraud detection alerts
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
