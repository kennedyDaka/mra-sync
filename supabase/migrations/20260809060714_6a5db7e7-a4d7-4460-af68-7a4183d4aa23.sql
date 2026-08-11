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