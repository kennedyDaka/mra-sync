-- Recipes / BOM (Bill of Materials) for manufacturing and restaurants
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
