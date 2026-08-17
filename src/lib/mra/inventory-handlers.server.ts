/**
 * Inventory & stock management handlers for MRA EIS API.
 * Covers: initial inventory, adjustments, transfers, raw material conversion,
 * goods receiving, product registration, credit/debit notes, and more.
 */
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readEnv } from "./env.server";
import { authenticateTenant, checkRateLimit, errorResponse, json } from "./http.server";
import { callMra, MRA_PATHS, summarizeErrors } from "./mra-client.server";
import { formatMraDateTime } from "./crypto.server";
import { logMraCall, loadCredentials, resolveSiteId, type TerminalRow } from "./sales.server";
import { TERMINAL_COLUMNS } from "./handlers.server";

/* ------------------------------------------------------------------ helpers */

async function getDb(): Promise<SupabaseClient> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as unknown as SupabaseClient;
}

async function getTerminalForRequest(
  request: Request,
  tenantId: string,
) {
  const terminalKey = request.headers.get("x-terminal-id");
  if (!terminalKey) {
    return { error: errorResponse(400, "missing_terminal", "X-Terminal-ID header is required") };
  }
  const db = await getDb();
  const { data: terminal } = await db
    .from("terminals")
    .select(TERMINAL_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("terminal_id", terminalKey)
    .maybeSingle<TerminalRow>();
  if (!terminal) {
    return { error: errorResponse(404, "unknown_terminal", `Terminal ${terminalKey} is not registered`) };
  }
  if (terminal.status !== "active") {
    return { error: errorResponse(409, "terminal_inactive", `Terminal ${terminalKey} is not activated`) };
  }
  const env = readEnv();
  const credentials = await loadCredentials(db, env, terminal.id);
  if (!credentials) {
    return { error: errorResponse(409, "terminal_inactive", "Terminal credentials are missing") };
  }
  return { terminal, credentials, env, db };
}

/* -------------------------------------------------- initial inventory upload */

const inventoryItemSchema = z.object({
  bar_code: z.string().min(1).max(120),
  product_name: z.string().min(1).max(200),
  product_description: z.string().min(1).max(500),
  unit_price: z.number().nonnegative().max(1_000_000_000),
  quantity_in_stock: z.number().nonnegative().max(10_000_000),
  cost_price: z.number().nonnegative().max(1_000_000_000),
  selling_price: z.number().nonnegative().max(1_000_000_000),
  reorder_level: z.number().nonnegative().optional(),
  over_quantity_stock_level: z.number().nonnegative().optional(),
});

const initialInventorySchema = z.object({
  tin: z.string().max(40).optional(),
  is_last_batch: z.boolean().optional(),
  products: z.array(inventoryItemSchema).min(1).max(500),
});

export async function handleInitialInventoryUpload(request: Request): Promise<Response> {
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

  const parsed = initialInventorySchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_payload", "Inventory payload failed validation", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }

  const result = await getTerminalForRequest(request, ctx.tenantId);
  if ("error" in result) return result.error;
  const { terminal, credentials } = result;

  const { data: tenantRow } = await db
    .from("tenants")
    .select("taxpayer_tin")
    .eq("id", ctx.tenantId)
    .maybeSingle();

  const payload = {
    tin: parsed.data.tin ?? tenantRow?.["taxpayer_tin"] ?? "",
    isLastBatch: parsed.data.is_last_batch ?? false,
    products: parsed.data.products.map((p) => ({
      barCode: p.bar_code,
      productName: p.product_name,
      productDescription: p.product_description,
      unitPrice: p.unit_price,
      quantityInStock: p.quantity_in_stock,
      costPrice: p.cost_price,
      sellingPrice: p.selling_price,
      reorderLevel: p.reorder_level ?? null,
      overQuantityStockLevel: p.over_quantity_stock_level ?? null,
    })),
  };

  const result2 = await callMra<{ uploaded?: number }>({
    env,
    path: MRA_PATHS.initialInventoryUpload,
    payload,
    auth: { jwtToken: credentials.jwtToken, secretKey: credentials.secretKey },
  });

  await logMraCall(db, {
    tenantId: ctx.tenantId,
    terminalUid: terminal.id,
    endpoint: MRA_PATHS.initialInventoryUpload,
    statusCode: result2.httpStatus,
    durationMs: result2.durationMs,
    ok: result2.ok,
    request: JSON.stringify(payload),
    response: result2.raw,
  });

  if (!result2.ok) {
    return errorResponse(502, "mra_rejection", summarizeErrors(result2), result2.errors);
  }

  return json({ uploaded: parsed.data.products.length, mra_data: result2.data });
}

/* -------------------------------------------------- stock adjustment */

const adjustmentSchema = z.object({
  barcode: z.string().min(1).max(120),
  quantity: z.number().positive().max(10_000_000),
  adjustment_reason: z.string().min(1).max(200),
  adjustment_type: z.enum(["Increase", "Decrease"]),
  site_id: z.string().max(40).optional(),
  taxpayer_remarks: z.string().max(500).optional(),
});

export async function handleStockAdjustment(request: Request): Promise<Response> {
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

  const parsed = adjustmentSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_payload", "Adjustment payload failed validation", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }

  const result = await getTerminalForRequest(request, ctx.tenantId);
  if ("error" in result) return result.error;
  const { terminal, credentials } = result;

  const payload = {
    barcode: parsed.data.barcode,
    quantity: parsed.data.quantity,
    adjustmentReason: parsed.data.adjustment_reason,
    adjustmentType: parsed.data.adjustment_type,
    siteId: parsed.data.site_id ?? resolveSiteId(terminal.config ?? {}, terminal.store_id),
    taxpayerRemarks: parsed.data.taxpayer_remarks ?? null,
  };

  const result2 = await callMra({
    env,
    path: MRA_PATHS.submitAdjustment,
    payload,
    auth: { jwtToken: credentials.jwtToken, secretKey: credentials.secretKey },
  });

  await logMraCall(db, {
    tenantId: ctx.tenantId,
    terminalUid: terminal.id,
    endpoint: MRA_PATHS.submitAdjustment,
    statusCode: result2.httpStatus,
    durationMs: result2.durationMs,
    ok: result2.ok,
    request: JSON.stringify(payload),
    response: result2.raw,
  });

  if (!result2.ok) {
    return errorResponse(502, "mra_rejection", summarizeErrors(result2), result2.errors);
  }

  return json({ status: "submitted", mra_data: result2.data });
}

/* -------------------------------------------------- get adjustment reasons */

export async function handleGetAdjustmentReasons(request: Request): Promise<Response> {
  const env = readEnv();
  const db = await getDb();

  const auth = await authenticateTenant(db, request);
  if (!auth.ok) return auth.response;
  const ctx = auth.context;

  const result = await getTerminalForRequest(request, ctx.tenantId);
  if ("error" in result) return result.error;
  const { credentials } = result;

  const result2 = await callMra<Array<{ id?: string; name?: string }>>({
    env,
    path: MRA_PATHS.getStockAdjustmentReasons,
    payload: {},
    auth: { jwtToken: credentials.jwtToken, secretKey: credentials.secretKey },
  });

  if (!result2.ok) {
    return errorResponse(502, "mra_rejection", summarizeErrors(result2), result2.errors);
  }

  return json({ reasons: result2.data ?? [] });
}

/* -------------------------------------------------- transfer inventory */

const transferItemSchema = z.object({
  barcode: z.string().max(120).optional(),
  quantity: z.number().positive().max(10_000_000),
  price: z.number().nonnegative().optional(),
});

const transferSchema = z.object({
  from_warehouse_to_site: z.boolean(),
  from_site_id: z.string().max(40).optional(),
  to_site_id: z.string().max(40).optional(),
  items: z.array(transferItemSchema).min(1).max(500),
});

export async function handleTransferInventory(request: Request): Promise<Response> {
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

  const parsed = transferSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_payload", "Transfer payload failed validation", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }

  const result = await getTerminalForRequest(request, ctx.tenantId);
  if ("error" in result) return result.error;
  const { terminal, credentials } = result;

  const payload = {
    fromWarehouseToSite: parsed.data.from_warehouse_to_site,
    fromSiteId: parsed.data.from_site_id ?? resolveSiteId(terminal.config ?? {}, terminal.store_id),
    toSiteId: parsed.data.to_site_id ?? "",
    items: parsed.data.items.map((i) => ({
      barcode: i.barcode ?? "",
      quantity: i.quantity,
      price: i.price ?? null,
    })),
  };

  const result2 = await callMra({
    env,
    path: MRA_PATHS.transferInventory,
    payload,
    auth: { jwtToken: credentials.jwtToken, secretKey: credentials.secretKey },
  });

  await logMraCall(db, {
    tenantId: ctx.tenantId,
    terminalUid: terminal.id,
    endpoint: MRA_PATHS.transferInventory,
    statusCode: result2.httpStatus,
    durationMs: result2.durationMs,
    ok: result2.ok,
    request: JSON.stringify(payload),
    response: result2.raw,
  });

  if (!result2.ok) {
    return errorResponse(502, "mra_rejection", summarizeErrors(result2), result2.errors);
  }

  return json({ status: "transferred", mra_data: result2.data });
}

/* -------------------------------------------------- raw material conversion */

const rawMaterialSchema = z.object({
  product_id: z.string().min(1).max(120),
  product_name: z.string().min(1).max(200),
  available_quantity: z.number().positive().max(10_000_000),
  used_quantity: z.number().positive().max(10_000_000),
});

const finishedProductSchema = z.object({
  barcode: z.string().min(1).max(120),
  product_description: z.string().min(1).max(500),
  quantity: z.number().positive().max(10_000_000),
  unit_of_measure: z.string().min(1).max(40),
  expiry_date: z.string().optional(),
});

const conversionSchema = z.object({
  production_batch_id: z.string().max(80).optional(),
  production_date: z.string().min(1),
  raw_materials: z.array(rawMaterialSchema).min(1).max(200),
  finished_products: z.array(finishedProductSchema).min(1).max(200),
});

export async function handleRawMaterialConversion(request: Request): Promise<Response> {
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

  const parsed = conversionSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_payload", "Conversion payload failed validation", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }

  const result = await getTerminalForRequest(request, ctx.tenantId);
  if ("error" in result) return result.error;
  const { terminal, credentials } = result;

  const payload = {
    productionBatchId: parsed.data.production_batch_id ?? null,
    productionDate: parsed.data.production_date,
    rawMaterials: parsed.data.raw_materials.map((r) => ({
      productId: r.product_id,
      productName: r.product_name,
      availableQuantity: r.available_quantity,
      usedQuantity: r.used_quantity,
    })),
    finishedProducts: parsed.data.finished_products.map((f) => ({
      barcode: f.barcode,
      productDescription: f.product_description,
      quantity: f.quantity,
      unitOfMeasure: f.unit_of_measure,
      expiryDate: f.expiry_date ?? null,
    })),
  };

  const result2 = await callMra({
    env,
    path: MRA_PATHS.submitConversion,
    payload,
    auth: { jwtToken: credentials.jwtToken, secretKey: credentials.secretKey },
  });

  await logMraCall(db, {
    tenantId: ctx.tenantId,
    terminalUid: terminal.id,
    endpoint: MRA_PATHS.submitConversion,
    statusCode: result2.httpStatus,
    durationMs: result2.durationMs,
    ok: result2.ok,
    request: JSON.stringify(payload),
    response: result2.raw,
  });

  if (!result2.ok) {
    return errorResponse(502, "mra_rejection", summarizeErrors(result2), result2.errors);
  }

  return json({ status: "converted", mra_data: result2.data });
}

/* -------------------------------------------------- add product */

const addProductSchema = z.object({
  barcode: z.string().min(4).max(120).optional(),
  hs_code: z.string().min(1).max(40),
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(500),
  uom: z.string().min(1).max(40),
});

export async function handleAddProduct(request: Request): Promise<Response> {
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

  const parsed = addProductSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_payload", "Product payload failed validation", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }

  const result = await getTerminalForRequest(request, ctx.tenantId);
  if ("error" in result) return result.error;
  const { terminal, credentials } = result;

  const payload = {
    barcode: parsed.data.barcode ?? null,
    hsCode: parsed.data.hs_code,
    name: parsed.data.name,
    description: parsed.data.description,
    uom: parsed.data.uom,
  };

  const result2 = await callMra({
    env,
    path: MRA_PATHS.addProduct,
    payload,
    auth: { jwtToken: credentials.jwtToken, secretKey: credentials.secretKey },
  });

  await logMraCall(db, {
    tenantId: ctx.tenantId,
    terminalUid: terminal.id,
    endpoint: MRA_PATHS.addProduct,
    statusCode: result2.httpStatus,
    durationMs: result2.durationMs,
    ok: result2.ok,
    request: JSON.stringify(payload),
    response: result2.raw,
  });

  if (!result2.ok) {
    return errorResponse(502, "mra_rejection", summarizeErrors(result2), result2.errors);
  }

  return json({ status: "registered", mra_data: result2.data });
}

/* -------------------------------------------------- get HS codes */

export async function handleGetHsCodes(request: Request): Promise<Response> {
  const env = readEnv();
  const db = await getDb();

  const auth = await authenticateTenant(db, request);
  if (!auth.ok) return auth.response;
  const ctx = auth.context;

  const result = await getTerminalForRequest(request, ctx.tenantId);
  if ("error" in result) return result.error;
  const { credentials } = result;

  const result2 = await callMra<Array<{ code?: string; description?: string }>>({
    env,
    path: MRA_PATHS.getHsCodes,
    payload: {},
    method: "GET",
    auth: { jwtToken: credentials.jwtToken, secretKey: credentials.secretKey },
  });

  if (!result2.ok) {
    return errorResponse(502, "mra_rejection", summarizeErrors(result2), result2.errors);
  }

  return json({ hs_codes: result2.data ?? [] });
}

/* -------------------------------------------------- get suppliers */

export async function handleGetSuppliers(request: Request): Promise<Response> {
  const env = readEnv();
  const db = await getDb();

  const auth = await authenticateTenant(db, request);
  if (!auth.ok) return auth.response;
  const ctx = auth.context;

  const result = await getTerminalForRequest(request, ctx.tenantId);
  if ("error" in result) return result.error;
  const { credentials } = result;

  const result2 = await callMra<Array<{ id?: number; name?: string }>>({
    env,
    path: MRA_PATHS.getSuppliers,
    payload: {},
    auth: { jwtToken: credentials.jwtToken, secretKey: credentials.secretKey },
  });

  if (!result2.ok) {
    return errorResponse(502, "mra_rejection", summarizeErrors(result2), result2.errors);
  }

  return json({ suppliers: result2.data ?? [] });
}

/* -------------------------------------------------- warehouse inventory */

export async function handleWarehouseInventory(request: Request): Promise<Response> {
  const env = readEnv();
  const db = await getDb();

  const auth = await authenticateTenant(db, request);
  if (!auth.ok) return auth.response;
  const ctx = auth.context;

  const result = await getTerminalForRequest(request, ctx.tenantId);
  if ("error" in result) return result.error;
  const { credentials } = result;

  const result2 = await callMra<Array<Record<string, unknown>>>({
    env,
    path: MRA_PATHS.warehouseInventory,
    payload: {},
    method: "GET",
    auth: { jwtToken: credentials.jwtToken, secretKey: credentials.secretKey },
  });

  if (!result2.ok) {
    return errorResponse(502, "mra_rejection", summarizeErrors(result2), result2.errors);
  }

  return json({ inventory: result2.data ?? [] });
}

/* -------------------------------------------------- credit/debit note */

const creditDebitLineSchema = z.object({
  product_code: z.string().max(120).optional(),
  description: z.string().max(500).optional(),
  unit_price: z.number().nonnegative().max(1_000_000_000),
  quantity: z.number().positive().max(10_000_000),
  discount: z.number().nonnegative().optional(),
  total: z.number().nonnegative().max(1_000_000_000),
  total_vat: z.number().nonnegative().max(1_000_000_000),
  tax_rate_id: z.string().max(20).optional(),
  is_product: z.boolean(),
});

const creditDebitSchema = z.object({
  original_invoice_number: z.string().min(1).max(120),
  adjustment_type: z.enum(["Credit", "Debit"]),
  reason: z.string().min(1).max(500),
  line_items: z.array(creditDebitLineSchema).min(1).max(500),
});

export async function handleCreditDebitNote(request: Request): Promise<Response> {
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

  const parsed = creditDebitSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_payload", "Credit/debit note payload failed validation", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }

  const result = await getTerminalForRequest(request, ctx.tenantId);
  if ("error" in result) return result.error;
  const { terminal, credentials } = result;

  const { data: tenantRow } = await db
    .from("tenants")
    .select("taxpayer_tin")
    .eq("id", ctx.tenantId)
    .maybeSingle();

  const config = terminal.config ?? {};

  const totalLineAmount = parsed.data.line_items.reduce((sum, i) => sum + i.total, 0);
  const totalLineVat = parsed.data.line_items.reduce((sum, i) => sum + i.total_vat, 0);

  const payload = {
    invoiceHeader: {
      invoiceNumber: parsed.data.original_invoice_number,
      invoiceDateTime: formatMraDateTime(new Date()),
      sellerTIN: tenantRow?.["taxpayer_tin"] ?? "",
      siteId: resolveSiteId(config, terminal.store_id),
      globalConfigVersion: terminal.global_config_version,
      taxpayerConfigVersion: terminal.taxpayer_config_version,
      terminalConfigVersion: terminal.terminal_config_version,
      isExport: false,
      isReliefSupply: false,
      paymentMethod: null,
    },
    invoiceLineItems: parsed.data.line_items.map((i) => ({
      productCode: i.product_code ?? null,
      description: i.description ?? null,
      unitPrice: i.unit_price,
      quantity: i.quantity,
      discount: i.discount ?? null,
      total: i.total,
      totalVAT: i.total_vat,
      taxRateId: i.tax_rate_id ?? null,
      isProduct: i.is_product,
    })),
    invoiceSummary: {
      taxBreakDown: [],
      totalVAT: totalLineVat,
      invoiceTotal: totalLineAmount,
    },
    reasonForAdjustment: parsed.data.reason,
  };

  const result2 = await callMra({
    env,
    path: MRA_PATHS.processCreditDebitNote,
    payload,
    auth: { jwtToken: credentials.jwtToken, secretKey: credentials.secretKey },
  });

  await logMraCall(db, {
    tenantId: ctx.tenantId,
    terminalUid: terminal.id,
    endpoint: MRA_PATHS.processCreditDebitNote,
    statusCode: result2.httpStatus,
    durationMs: result2.durationMs,
    ok: result2.ok,
    request: JSON.stringify(payload),
    response: result2.raw,
  });

  if (!result2.ok) {
    return errorResponse(502, "mra_rejection", summarizeErrors(result2), result2.errors);
  }

  return json({ status: "submitted", mra_data: result2.data });
}

/* -------------------------------------------------- get invoice by number */

const getInvoiceSchema = z.object({
  invoice_number: z.string().min(1).max(120),
});

export async function handleGetInvoiceByNumber(request: Request): Promise<Response> {
  const env = readEnv();
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

  const parsed = getInvoiceSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_payload", "Invoice lookup payload failed validation", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }

  const result = await getTerminalForRequest(request, ctx.tenantId);
  if ("error" in result) return result.error;
  const { terminal, credentials } = result;

  const result2 = await callMra({
    env,
    path: MRA_PATHS.getInvoiceByNumber,
    payload: { invoiceNumber: parsed.data.invoice_number },
    auth: { jwtToken: credentials.jwtToken, secretKey: credentials.secretKey },
  });

  await logMraCall(db, {
    tenantId: ctx.tenantId,
    terminalUid: terminal.id,
    endpoint: MRA_PATHS.getInvoiceByNumber,
    statusCode: result2.httpStatus,
    durationMs: result2.durationMs,
    ok: result2.ok,
    request: JSON.stringify({ invoiceNumber: parsed.data.invoice_number }),
    response: result2.raw,
  });

  if (!result2.ok) {
    return errorResponse(502, "mra_rejection", summarizeErrors(result2), result2.errors);
  }

  return json({ invoice: result2.data });
}

/* -------------------------------------------------- product status */

const productStatusSchema = z.object({
  barcode: z.string().min(1).max(120),
});

export async function handleProductStatus(request: Request): Promise<Response> {
  const env = readEnv();
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

  const parsed = productStatusSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_payload", "Product status payload failed validation", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }

  const result = await getTerminalForRequest(request, ctx.tenantId);
  if ("error" in result) return result.error;
  const { credentials } = result;

  const result2 = await callMra({
    env,
    path: MRA_PATHS.productStatus,
    payload: { barcode: parsed.data.barcode },
    auth: { jwtToken: credentials.jwtToken, secretKey: credentials.secretKey },
  });

  if (!result2.ok) {
    return errorResponse(502, "mra_rejection", summarizeErrors(result2), result2.errors);
  }

  return json({ status: result2.data });
}
