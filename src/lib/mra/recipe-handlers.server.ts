/**
 * Recipe / BOM (Bill of Materials) handlers.
 * Supports manufacturing (raw material → finished goods) and
 * restaurant (just-in-time conversion at checkout).
 */
import { z } from "zod";
import { authenticateTenant, checkRateLimit, errorResponse, json } from "./http.server";
import { callMra, MRA_PATHS, summarizeErrors } from "./mra-client.server";
import { readEnv } from "./env.server";
import { logMraCall } from "./sales.server";
import type { SupabaseClient } from "@supabase/supabase-js";

async function getDb(): Promise<SupabaseClient> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as unknown as SupabaseClient;
}

/* -------------------------------------------------- schemas */

const recipeItemInput = z.object({
  raw_material_code: z.string().min(1).max(120),
  raw_material_name: z.string().min(1).max(200),
  quantity_per_unit: z.number().positive().max(10_000_000),
  unit_of_measure: z.string().min(1).max(40).default("kg"),
  waste_factor: z.number().nonnegative().max(1).default(0),
});

const createRecipeSchema = z.object({
  finished_product_code: z.string().min(1).max(120),
  finished_product_name: z.string().min(1).max(200),
  conversion_factor: z.number().positive().max(10_000_000).default(1),
  unit_of_measure: z.string().min(1).max(40).default("unit"),
  items: z.array(recipeItemInput).min(1).max(200),
});

const updateRecipeSchema = z.object({
  recipe_id: z.string().uuid(),
  finished_product_name: z.string().min(1).max(200).optional(),
  conversion_factor: z.number().positive().optional(),
  unit_of_measure: z.string().min(1).max(40).optional(),
  is_active: z.boolean().optional(),
  items: z.array(recipeItemInput).min(1).max(200).optional(),
});

/* -------------------------------------------------- handlers */

export async function handleCreateRecipe(request: Request): Promise<Response> {
  const db = await getDb();
  const auth = await authenticateTenant(db, request);
  if (!auth.ok) return auth.response;
  const ctx = auth.context;

  if (!(await checkRateLimit(db, ctx.tenantId, ctx.rateLimitPerMin))) {
    return errorResponse(429, "rate_limited", "Too many requests for this tenant");
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, "invalid_json", "Request body is not valid JSON");
  }

  const parsed = createRecipeSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_payload", "Recipe payload failed validation", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }

  const { data: recipe, error: recipeError } = await db
    .from("recipes")
    .insert({
      tenant_id: ctx.tenantId,
      finished_product_code: parsed.data.finished_product_code,
      finished_product_name: parsed.data.finished_product_name,
      conversion_factor: parsed.data.conversion_factor,
      unit_of_measure: parsed.data.unit_of_measure,
    })
    .select("id")
    .single();

  if (recipeError) {
    if (recipeError.code === "23505") {
      return errorResponse(409, "duplicate", "A recipe with this product code already exists");
    }
    return errorResponse(500, "db_error", recipeError.message);
  }

  const items = parsed.data.items.map((item) => ({
    recipe_id: recipe.id,
    raw_material_code: item.raw_material_code,
    raw_material_name: item.raw_material_name,
    quantity_per_unit: item.quantity_per_unit,
    unit_of_measure: item.unit_of_measure,
    waste_factor: item.waste_factor,
  }));

  const { error: itemsError } = await db.from("recipe_items").insert(items);
  if (itemsError) {
    return errorResponse(500, "db_error", itemsError.message);
  }

  return json({ recipe_id: recipe.id, items: items.length }, 201);
}

export async function handleListRecipes(request: Request): Promise<Response> {
  const db = await getDb();
  const auth = await authenticateTenant(db, request);
  if (!auth.ok) return auth.response;
  const ctx = auth.context;

  const { data: recipes, error } = await db
    .from("recipes")
    .select("id, finished_product_code, finished_product_name, conversion_factor, unit_of_measure, is_active, created_at")
    .eq("tenant_id", ctx.tenantId)
    .order("created_at", { ascending: false });

  if (error) return errorResponse(500, "db_error", error.message);
  return json({ recipes: recipes ?? [] });
}

export async function handleGetRecipe(request: Request): Promise<Response> {
  const db = await getDb();
  const auth = await authenticateTenant(db, request);
  if (!auth.ok) return auth.response;
  const ctx = auth.context;

  const url = new URL(request.url);
  const recipeId = url.searchParams.get("recipe_id");
  if (!recipeId) {
    return errorResponse(400, "missing_param", "recipe_id query parameter is required");
  }

  const { data: recipe, error } = await db
    .from("recipes")
    .select("id, finished_product_code, finished_product_name, conversion_factor, unit_of_measure, is_active, created_at")
    .eq("id", recipeId)
    .eq("tenant_id", ctx.tenantId)
    .maybeSingle();

  if (error) return errorResponse(500, "db_error", error.message);
  if (!recipe) return errorResponse(404, "not_found", "Recipe not found");

  const { data: items } = await db
    .from("recipe_items")
    .select("id, raw_material_code, raw_material_name, quantity_per_unit, unit_of_measure, waste_factor")
    .eq("recipe_id", recipeId);

  return json({ recipe, items: items ?? [] });
}

export async function handleUpdateRecipe(request: Request): Promise<Response> {
  const db = await getDb();
  const auth = await authenticateTenant(db, request);
  if (!auth.ok) return auth.response;
  const ctx = auth.context;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, "invalid_json", "Request body is not valid JSON");
  }

  const parsed = updateRecipeSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_payload", "Update payload failed validation", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }

  // Verify ownership
  const { data: existing } = await db
    .from("recipes")
    .select("id")
    .eq("id", parsed.data.recipe_id)
    .eq("tenant_id", ctx.tenantId)
    .maybeSingle();

  if (!existing) return errorResponse(404, "not_found", "Recipe not found");

  // Update recipe fields
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data["finished_product_name"]) updates["finished_product_name"] = parsed.data["finished_product_name"];
  if (parsed.data["conversion_factor"]) updates["conversion_factor"] = parsed.data["conversion_factor"];
  if (parsed.data["unit_of_measure"]) updates["unit_of_measure"] = parsed.data["unit_of_measure"];
  if (parsed.data["is_active"] !== undefined) updates["is_active"] = parsed.data["is_active"];

  const { error: updateError } = await db
    .from("recipes")
    .update(updates)
    .eq("id", parsed.data.recipe_id);

  if (updateError) return errorResponse(500, "db_error", updateError.message);

  // Replace items if provided
  if (parsed.data.items) {
    await db.from("recipe_items").delete().eq("recipe_id", parsed.data.recipe_id);
    const items = parsed.data.items.map((item) => ({
      recipe_id: parsed.data.recipe_id,
      raw_material_code: item.raw_material_code,
      raw_material_name: item.raw_material_name,
      quantity_per_unit: item.quantity_per_unit,
      unit_of_measure: item.unit_of_measure,
      waste_factor: item.waste_factor,
    }));
    const { error: itemsError } = await db.from("recipe_items").insert(items);
    if (itemsError) return errorResponse(500, "db_error", itemsError.message);
  }

  return json({ updated: true });
}

export async function handleDeleteRecipe(request: Request): Promise<Response> {
  const db = await getDb();
  const auth = await authenticateTenant(db, request);
  if (!auth.ok) return auth.response;
  const ctx = auth.context;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, "invalid_json", "Request body is not valid JSON");
  }

  const { recipe_id } = z.object({ recipe_id: z.string().uuid() }).parse(raw);

  const { data: existing } = await db
    .from("recipes")
    .select("id")
    .eq("id", recipe_id)
    .eq("tenant_id", ctx.tenantId)
    .maybeSingle();

  if (!existing) return errorResponse(404, "not_found", "Recipe not found");

  const { error } = await db.from("recipes").delete().eq("id", recipe_id);
  if (error) return errorResponse(500, "db_error", error.message);

  return json({ deleted: true });
}

/* -------------------------------------------------- recipe conversion (→ MRA) */

const convertRecipeSchema = z.object({
  recipe_id: z.string().uuid(),
  quantity_to_produce: z.number().positive().max(10_000_000),
  production_batch_id: z.string().max(80).optional(),
  production_date: z.string().min(1).optional(),
});

export async function handleConvertRecipe(request: Request): Promise<Response> {
  const env = readEnv();
  const db = await getDb();

  const auth = await authenticateTenant(db, request);
  if (!auth.ok) return auth.response;
  const ctx = auth.context;

  if (!(await checkRateLimit(db, ctx.tenantId, ctx.rateLimitPerMin))) {
    return errorResponse(429, "rate_limited", "Too many requests for this tenant");
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, "invalid_json", "Request body is not valid JSON");
  }

  const parsed = convertRecipeSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_payload", "Conversion payload failed validation", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }

  const terminalKey = request.headers.get("x-terminal-id");
  if (!terminalKey) {
    return errorResponse(400, "missing_terminal", "X-Terminal-ID header is required");
  }

  const { data: terminal } = await db
    .from("terminals")
    .select("*")
    .eq("tenant_id", ctx.tenantId)
    .eq("terminal_id", terminalKey)
    .maybeSingle();
  if (!terminal) {
    return errorResponse(404, "unknown_terminal", `Terminal ${terminalKey} is not registered`);
  }
  if (terminal.status !== "active") {
    return errorResponse(409, "terminal_inactive", `Terminal ${terminalKey} is not activated`);
  }

  const { loadCredentials } = await import("@/lib/mra/sales.server");
  const credentials = await loadCredentials(db, env, terminal.id);
  if (!credentials) {
    return errorResponse(409, "terminal_inactive", "Terminal credentials are missing");
  }

  // Fetch recipe + items
  const { data: recipe, error: recipeErr } = await db
    .from("recipes")
    .select("id, finished_product_code, finished_product_name, conversion_factor, unit_of_measure")
    .eq("id", parsed.data.recipe_id)
    .eq("tenant_id", ctx.tenantId)
    .maybeSingle();

  if (recipeErr) return errorResponse(500, "db_error", recipeErr.message);
  if (!recipe) return errorResponse(404, "not_found", "Recipe not found");
  if (!recipe.conversion_factor || recipe.conversion_factor <= 0) {
    return errorResponse(400, "invalid_recipe", "Recipe has an invalid conversion_factor");
  }

  const { data: items, error: itemsErr } = await db
    .from("recipe_items")
    .select("raw_material_code, raw_material_name, quantity_per_unit, unit_of_measure, waste_factor")
    .eq("recipe_id", recipe.id);

  if (itemsErr) return errorResponse(500, "db_error", itemsErr.message);
  if (!items || items.length === 0) {
    return errorResponse(400, "empty_recipe", "Recipe has no raw material items");
  }

  const qty = parsed.data.quantity_to_produce;

  // Build raw materials list: quantity_per_unit × quantity_to_produce × (1 + waste_factor)
  const rawMaterials = items.map((item) => {
    const waste = item.waste_factor ?? 0;
    const usedQty = item.quantity_per_unit * qty * (1 + waste);
    return {
      productId: item.raw_material_code,
      productName: item.raw_material_name,
      availableQuantity: usedQty,
      usedQuantity: usedQty,
    };
  });

  // Build finished products list
  const finishedProducts = [{
    barcode: recipe.finished_product_code,
    productDescription: recipe.finished_product_name,
    quantity: qty,
    unitOfMeasure: recipe.unit_of_measure || "unit",
    expiryDate: null,
  }];

  const mraPayload = {
    productionBatchId: parsed.data.production_batch_id ?? null,
    productionDate: parsed.data.production_date ?? new Date().toISOString().split("T")[0],
    rawMaterials,
    finishedProducts,
  };

  const result = await callMra({
    env,
    path: MRA_PATHS.submitConversion,
    payload: mraPayload,
    auth: { jwtToken: credentials.jwtToken, secretKey: credentials.secretKey },
  });

  await logMraCall(db, {
    tenantId: ctx.tenantId,
    terminalUid: terminal.id,
    endpoint: MRA_PATHS.submitConversion,
    statusCode: result.httpStatus,
    durationMs: result.durationMs,
    ok: result.ok,
    request: JSON.stringify(mraPayload),
    response: result.raw,
  });

  if (!result.ok) {
    return errorResponse(502, "mra_rejection", summarizeErrors(result), result.errors);
  }

  return json({
    status: "converted",
    recipe_id: recipe.id,
    finished_product: recipe.finished_product_code,
    quantity_produced: qty,
    raw_materials_consumed: rawMaterials.length,
    mra_data: result.data,
  });
}
