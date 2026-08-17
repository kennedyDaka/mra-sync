-- Add unit_price to product_maps so ERP product sync (listProducts) can persist catalog prices.
ALTER TABLE public.product_maps
  ADD COLUMN IF NOT EXISTS unit_price NUMERIC(18, 2) DEFAULT 0 NOT NULL;