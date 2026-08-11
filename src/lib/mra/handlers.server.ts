/**
 * Endpoint orchestration for the MRA EIS middleware.
 * Every MRA interaction follows the official Developers Guide flow:
 * activate-terminal -> terminal-activated-confirmation -> get-latest-configs
 * -> submit-sales-transaction (with offline signing + catch-up sync).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { canonicalJson, hmacSha512Base64, mintApiToken, sealSecret } from "./crypto.server";
import { readEnv, type MraEnv } from "./env.server";
import { authenticateTenant, checkRateLimit, errorResponse, json } from "./http.server";
import { callMra, MRA_PATHS, summarizeErrors } from "./mra-client.server";
import {
  buildOfflineValidation,
  buildSalesInvoice,
  defaultTaxRateId,
  generateInvoiceNumber,
  loadCredentials,
  logMraCall,
  resolveMappings,
  salesSchema,
  submitInvoiceToMra,
  type TerminalRow,
} from "./sales.server";

const IDEMPOTENCY_WINDOW_HOURS = 48;

export const TERMINAL_COLUMNS =
  "id, tenant_id, store_id, terminal_id, mra_terminal_ref, status, config, taxpayer_id, terminal_position, global_config_version, taxpayer_config_version, terminal_config_version, is_blocked, offline_max_age_hours, offline_max_amount, offline_accumulated, last_config_sync_at";

async function getDb(): Promise<SupabaseClient> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as unknown as SupabaseClient;
}

function receiptFor(row: Record<string, unknown>) {
  return {
    invoice_id: row["id"],
    erp_invoice_number: row["erp_invoice_number"],
    mra_invoice_number: row["mra_invoice_number"],
    status: row["status"],
    validation_url: row["validation_url"],
    qr_payload: row["qr_payload"],
    offline_signature: row["offline_signature"],
    invoice_sequence: row["invoice_sequence"],
    total_vat: Number(row["total_vat"] ?? 0),
    grand_total: Number(row["grand_total"] ?? 0),
    is_offline: row["is_offline"],
  };
}

/** Persists configuration versions and offline limits returned by MRA. */
async function storeConfiguration(
  db: SupabaseClient,
  terminalUid: string,
  configuration: Record<string, unknown>,
) {
  const global = (configuration["globalConfiguration"] ?? {}) as Record<string, unknown>;
  const taxpayer = (configuration["taxpayerConfiguration"] ?? {}) as Record<string, unknown>;
  const terminal = (configuration["terminalConfiguration"] ?? {}) as Record<string, unknown>;
  const offline = (terminal["offlineLimit"] ?? {}) as Record<string, unknown>;

  await db
    .from("terminals")
    .update({
      config: configuration,
      global_config_version: Number(global["versionNo"] ?? 0),
      taxpayer_config_version: Number(taxpayer["versionNo"] ?? 0),
      terminal_config_version: Number(terminal["versionNo"] ?? 0),
      offline_max_age_hours: Number(offline["maxTransactionAgeInHours"] ?? 0),
      offline_max_amount: Number(offline["maxCummulativeAmount"] ?? 0),
      last_config_sync_at: new Date().toISOString(),
    })
    .eq("id", terminalUid);
}

/** Pulls the latest configuration for one terminal (section 5.2.1). */
async function refreshConfiguration(
  db: SupabaseClient,
  env: MraEnv,
  terminal: { id: string; tenant_id: string },
  jwtToken: string | null,
): Promise<boolean> {
  const result = await callMra<Record<string, unknown>>({
    env,
    path: MRA_PATHS.getLatestConfigs,
    payload: {},
    auth: { jwtToken },
    timeoutMs: 10_000,
  });

  await logMraCall(db, {
    tenantId: terminal.tenant_id,
    terminalUid: terminal.id,
    endpoint: MRA_PATHS.getLatestConfigs,
    statusCode: result.httpStatus,
    durationMs: result.durationMs,
    ok: result.ok,
    request: "{}",
    response: result.raw || (result.error ?? ""),
  });

  if (!result.ok || !result.data) return false;
  await storeConfiguration(db, terminal.id, result.data);
  return true;
}

/** Fetches and stores the block reason (section 5.4 utilities). */
async function captureBlockingMessage(
  db: SupabaseClient,
  env: MraEnv,
  terminal: { id: string; tenant_id: string },
  jwtToken: string | null,
) {
  const result = await callMra<unknown>({
    env,
    path: MRA_PATHS.terminalBlockingMessage,
    payload: {},
    auth: { jwtToken },
    timeoutMs: 10_000,
  });

  const message =
    typeof result.data === "string"
      ? result.data
      : ((result.data as Record<string, unknown>)?.["message"] as string) ??
        result.remark ??
        "Terminal blocked by MRA";

  await db
    .from("terminals")
    .update({ is_blocked: true, blocking_message: message, status: "blocked" })
    .eq("id", terminal.id);
}

/* ------------------------------------------------------------------ sales */

export async function handleSales(request: Request): Promise<Response> {
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

  const parsed = salesSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_payload", "Invoice payload failed validation", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  const input = parsed.data;

  const terminalKey = request.headers.get("x-terminal-id");
  if (!terminalKey) {
    return errorResponse(400, "missing_terminal", "X-Terminal-ID header is required");
  }

  // Idempotency: tenant_id + erp_invoice_number within a 48h window.
  const since = new Date(Date.now() - IDEMPOTENCY_WINDOW_HOURS * 3600_000).toISOString();
  const { data: existing } = await db
    .from("invoices")
    .select("*")
    .eq("tenant_id", ctx.tenantId)
    .eq("erp_invoice_number", input.erp_invoice_number)
    .gte("created_at", since)
    .maybeSingle();

  if (existing) {
    const status = existing["status"] === "SUBMITTED" ? 200 : 202;
    return json({ ...receiptFor(existing), duplicate: true }, status);
  }

  const { data: terminal } = await db
    .from("terminals")
    .select(TERMINAL_COLUMNS)
    .eq("tenant_id", ctx.tenantId)
    .eq("terminal_id", terminalKey)
    .maybeSingle<TerminalRow>();

  if (!terminal) {
    return errorResponse(404, "unknown_terminal", `Terminal ${terminalKey} is not registered`);
  }
  if (terminal.status !== "active") {
    return errorResponse(409, "terminal_inactive", `Terminal ${terminalKey} is not activated`);
  }
  if (terminal.is_blocked) {
    return errorResponse(423, "terminal_blocked", "Terminal is blocked by MRA — sales must stop");
  }

  const mappings = await resolveMappings(db, env, ctx.tenantId, input.line_items);
  if (!mappings.ok) {
    return errorResponse(
      422,
      "unmapped_compliance_sku",
      "Unmapped Compliance SKU - register these items before selling",
      { unmapped_skus: mappings.unmapped },
    );
  }

  const credentials = await loadCredentials(db, env, terminal.id);
  if (!credentials) {
    return errorResponse(409, "terminal_inactive", "Terminal credentials are missing");
  }

  const { data: tenantRow } = await db
    .from("tenants")
    .select("taxpayer_tin")
    .eq("id", ctx.tenantId)
    .maybeSingle();

  const { data: sequence } = await db.rpc("next_invoice_sequence", {
    _terminal_uid: terminal.id,
  });
  const transactionCount = Number(sequence ?? 0);

  const invoiceDateTime = input.invoice_timestamp
    ? new Date(input.invoice_timestamp)
    : new Date();

  const invoiceNumber = generateInvoiceNumber({
    taxpayerId: Number(terminal.taxpayer_id ?? 0),
    terminalPosition: Number(terminal.terminal_position ?? 1),
    transactionDate: invoiceDateTime,
    transactionCount,
  });

  const built = buildSalesInvoice({
    input,
    terminal,
    sellerTin: (tenantRow?.["taxpayer_tin"] as string) ?? "",
    invoiceNumber,
    invoiceDateTime,
    mappings: mappings.bySku,
  });

  const isOffline = input.is_offline === true;

  // Offline receipts are locally signed so the POS can print immediately.
  const offlineValidation = await buildOfflineValidation({
    env,
    secretKey: credentials.secretKey,
    invoiceNumber,
    numItems: built.numItems,
    invoiceTotal: built.invoiceTotal,
    vatAmount: built.totalVat,
    transactionDate: invoiceDateTime,
  });

  if (isOffline) {
    // Offline thresholds (section 6.3) are hard limits enforced by the terminal.
    const ageOk =
      terminal.offline_max_age_hours <= 0 ||
      Date.now() - invoiceDateTime.getTime() <= terminal.offline_max_age_hours * 3600_000;
    const amountOk =
      terminal.offline_max_amount <= 0 ||
      terminal.offline_accumulated + built.invoiceTotal <= terminal.offline_max_amount;

    if (!ageOk || !amountOk) {
      return errorResponse(
        409,
        "offline_threshold_exceeded",
        "Offline threshold exceeded — the terminal must reconnect to MRA before transacting",
        {
          max_transaction_age_hours: terminal.offline_max_age_hours,
          max_cumulative_amount: terminal.offline_max_amount,
          accumulated: terminal.offline_accumulated,
        },
      );
    }

    (built.payload["invoiceSummary"] as Record<string, unknown>)["offlineSignature"] =
      offlineValidation.offlineSignature;
  }

  const { data: invoice, error: insertError } = await db
    .from("invoices")
    .insert({
      tenant_id: ctx.tenantId,
      terminal_uid: terminal.id,
      erp_invoice_number: input.erp_invoice_number,
      mra_invoice_number: invoiceNumber,
      idempotency_key: request.headers.get("idempotency-key"),
      cashier_id: input.cashier_id ?? null,
      customer_tin: input.customer_tin ?? null,
      status: "PENDING_SYNC",
      is_offline: isOffline,
      erp_payload: input,
      mra_payload: built.payload,
      invoice_sequence: transactionCount,
      transaction_count: transactionCount,
      offline_signature: isOffline ? offlineValidation.offlineSignature : null,
      validation_url: offlineValidation.validationUrl,
      signature: offlineValidation.offlineSignature,
      qr_payload: offlineValidation.validationUrl,
      total_vat: built.totalVat,
      grand_total: built.invoiceTotal,
    })
    .select("*")
    .single();

  if (insertError || !invoice) {
    const { data: dupe } = await db
      .from("invoices")
      .select("*")
      .eq("tenant_id", ctx.tenantId)
      .eq("erp_invoice_number", input.erp_invoice_number)
      .maybeSingle();
    if (dupe) return json({ ...receiptFor(dupe), duplicate: true }, 200);
    return errorResponse(500, "persist_failed", insertError?.message ?? "Could not store invoice");
  }

  const enqueue = async (reason: string) => {
    await db
      .from("sync_queue")
      .upsert({ tenant_id: ctx.tenantId, invoice_id: invoice["id"] }, { onConflict: "invoice_id" });
    await db
      .from("invoices")
      .update({ status: "QUEUED", last_error: reason })
      .eq("id", invoice["id"]);
    await db
      .from("terminals")
      .update({ offline_accumulated: terminal.offline_accumulated + built.invoiceTotal })
      .eq("id", terminal.id);
    return json({ ...receiptFor({ ...invoice, status: "QUEUED" }), queued: true, reason }, 202);
  };

  // Fraud detection: run async after invoice creation, don't block submission
  const { analyzeInvoice } = await import("./fraud-detection.server");
  analyzeInvoice(db, {
    id: invoice["id"],
    tenant_id: ctx.tenantId,
    store_id: terminal.store_id,
    terminal_uid: terminal.id,
    erp_invoice_number: input.erp_invoice_number,
    total_amount: built.invoiceTotal,
    total_tax: built.totalVat,
    line_items: input.line_items.map((li) => ({
      tax_rate_id: li.tax_rate_id ?? null,
      quantity: li.quantity,
      unit_price: li.unit_price,
      total: li.quantity * li.unit_price,
    })),
    created_at: new Date().toISOString(),
  }).catch((err) => console.error("Fraud detection error:", err));

  if (isOffline) return enqueue("Invoice flagged offline by POS");

  const outcome = await submitInvoiceToMra({
    db,
    env,
    tenantId: ctx.tenantId,
    terminalUid: terminal.id,
    payload: built.payload,
    credentials,
    timeoutMs: env.timeoutMs,
  });

  if (outcome.shouldDownloadLatestConfig) {
    await refreshConfiguration(db, env, terminal, credentials.jwtToken);
  }
  if (outcome.shouldBlockTerminal) {
    await captureBlockingMessage(db, env, terminal, credentials.jwtToken);
  }

  if (outcome.submitted) {
    const { data: updated } = await db
      .from("invoices")
      .update({
        status: "SUBMITTED",
        mra_invoice_id: invoiceNumber,
        validation_url: outcome.validationUrl ?? offlineValidation.validationUrl,
        qr_payload: outcome.validationUrl ?? offlineValidation.validationUrl,
        offline_signature: null,
        mra_response: outcome.response as Record<string, unknown>,
        submitted_at: new Date().toISOString(),
        attempts: 1,
        last_error: null,
      })
      .eq("id", invoice["id"])
      .select("*")
      .single();
    return json(receiptFor(updated ?? invoice), 200);
  }

  if (outcome.rejected) {
    await db
      .from("invoices")
      .update({
        status: "REJECTED",
        mra_response: outcome.response as Record<string, unknown>,
        attempts: 1,
        last_error: outcome.error,
      })
      .eq("id", invoice["id"]);
    return errorResponse(422, "mra_rejected", outcome.error ?? "MRA rejected the invoice", {
      mra_status_code: outcome.statusCode,
      mra_http_status: outcome.httpStatus,
      mra_response: outcome.response,
    });
  }

  // Gateway unreachable: fall back to the offline receipt and sync later.
  (built.payload["invoiceSummary"] as Record<string, unknown>)["offlineSignature"] =
    offlineValidation.offlineSignature;
  await db
    .from("invoices")
    .update({
      is_offline: true,
      offline_signature: offlineValidation.offlineSignature,
      mra_payload: built.payload,
    })
    .eq("id", invoice["id"]);

  return enqueue(outcome.error ?? "MRA gateway unavailable");
}

/* ------------------------------------------------------------- activation */

const activateSchema = z.object({
  store_id: z.string().min(1).max(80),
  terminal_id: z.string().min(1).max(80),
  tac: z.string().min(1).max(50),
  taxpayer_tin: z.string().max(40).optional(),
  platform: z
    .object({
      os_name: z.string().max(50),
      os_version: z.string().max(50),
      os_build: z.string().max(50).optional(),
      mac_address: z.string().max(17),
    })
    .optional(),
  pos: z
    .object({
      product_id: z.string().max(50),
      product_version: z.string().max(50),
    })
    .optional(),
});

/**
 * Two-step onboarding per section 5.1:
 *  1. POST /onboarding/activate-terminal  (x-access-key in production)
 *  2. POST /onboarding/terminal-activated-confirmation
 *     with x-signature = Base64(HMAC-SHA512(TAC, secretKey))
 */
export async function handleActivate(request: Request): Promise<Response> {
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

  const parsed = activateSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_payload", "Activation payload failed validation", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }

  return activateTerminalCore(db, env, ctx.tenantId, parsed.data);
}

export type ActivateInput = z.infer<typeof activateSchema>;

/**
 * Shared activation engine used by both the ERP-facing endpoint and the
 * self-service dashboard flow, so tenants can activate terminals themselves
 * even when their POS has no activation screen.
 */
export async function activateTerminalCore(
  db: Awaited<ReturnType<typeof getDb>>,
  env: ReturnType<typeof readEnv>,
  tenantId: string,
  input: ActivateInput,
): Promise<Response> {
  const ctx = { tenantId };

  const activationPayload = {
    terminalActivationCode: input.tac,
    environment: {
      platform: {
        osName: input.platform?.os_name ?? "Linux",
        osVersion: input.platform?.os_version ?? "1.0",
        osBuild: input.platform?.os_build ?? "1.0",
        // MRA requires macAddress (despite Swagger listing it as nullable).
        // POS-initiated: caller sends the real MAC of the POS machine.
        // Self-service: admin.functions.ts generates a deterministic MAC.
        // If nothing is provided, use a placeholder — but MRA will reject it.
        macAddress: input.platform?.mac_address ?? "00-00-00-00-00-00",
      },
      pos: {
        productID: input.pos?.product_id ?? env.posProductId,
        productVersion: input.pos?.product_version ?? env.posProductVersion,
      },
    },
  };

  const activation = await callMra<{
    activatedTerminal?: {
      terminalId?: string;
      terminalPosition?: number;
      taxpayerId?: number;
      activationDate?: string;
      terminalCredentials?: { jwtToken?: string; secretKey?: string };
    };
    configuration?: Record<string, unknown>;
  }>({
    env,
    path: MRA_PATHS.activateTerminal,
    payload: activationPayload,
    // Vendor Access Key is required only in production (section 4.1.1.1).
    auth: env.isProduction ? { accessKey: env.vendorAccessKey } : {},
    timeoutMs: 20_000,
  });

  await logMraCall(db, {
    tenantId: ctx.tenantId,
    endpoint: MRA_PATHS.activateTerminal,
    statusCode: activation.httpStatus,
    durationMs: activation.durationMs,
    ok: activation.ok,
    request: canonicalJson({
      ...activationPayload,
      terminalActivationCode: "***",
    }),
    response: activation.raw || (activation.error ?? ""),
  });

  const { data: terminal, error: terminalError } = await db
    .from("terminals")
    .upsert(
      {
        tenant_id: ctx.tenantId,
        store_id: input.store_id,
        terminal_id: input.terminal_id,
        activation_code: input.tac,
        status: activation.ok ? "pending" : "error",
        last_error: activation.ok ? null : summarizeErrors(activation),
      },
      { onConflict: "tenant_id,terminal_id" },
    )
    .select("id")
    .single();

  if (terminalError || !terminal) {
    return errorResponse(500, "persist_failed", terminalError?.message ?? "Could not save terminal");
  }
  const terminalUid = terminal["id"] as string;

  if (!activation.ok) {
    return errorResponse(502, "activation_failed", summarizeErrors(activation), {
      mra_status_code: activation.statusCode,
      mra_http_status: activation.httpStatus,
      mra_errors: activation.errors,
    });
  }

  const activated = activation.data?.activatedTerminal;
  const secretKey = activated?.terminalCredentials?.secretKey;
  const jwtToken = activated?.terminalCredentials?.jwtToken;

  if (!secretKey || !jwtToken || !activated?.terminalId) {
    return errorResponse(502, "activation_incomplete", "MRA did not return terminal credentials", {
      mra_response: activation.data,
    });
  }

  await db.from("terminal_secrets").upsert(
    {
      terminal_uid: terminalUid,
      tenant_id: ctx.tenantId,
      access_key_enc: await sealSecret(env.vendorAccessKey, env.masterKey, env.isProduction),
      secret_key_enc: await sealSecret(secretKey, env.masterKey, env.isProduction),
      session_token_enc: await sealSecret(jwtToken, env.masterKey, env.isProduction),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "terminal_uid" },
  );

  await db
    .from("terminals")
    .update({
      mra_terminal_ref: activated.terminalId,
      taxpayer_id: activated.taxpayerId ?? null,
      terminal_position: activated.terminalPosition ?? 1,
      activated_at: activated.activationDate ?? new Date().toISOString(),
    })
    .eq("id", terminalUid);

  if (activation.data?.configuration) {
    await storeConfiguration(db, terminalUid, activation.data.configuration);
  }

  // Step 2 — confirm activation with the x-signature over the TAC.
  const xSignature = await hmacSha512Base64(secretKey, input.tac);
  const confirmation = await callMra<boolean>({
    env,
    path: MRA_PATHS.terminalActivatedConfirmation,
    payload: { terminalId: activated.terminalId },
    auth: { jwtToken, xSignature },
    timeoutMs: 20_000,
  });

  await logMraCall(db, {
    tenantId: ctx.tenantId,
    terminalUid,
    endpoint: MRA_PATHS.terminalActivatedConfirmation,
    statusCode: confirmation.httpStatus,
    durationMs: confirmation.durationMs,
    ok: confirmation.ok,
    request: canonicalJson({ terminalId: activated.terminalId }),
    response: confirmation.raw || (confirmation.error ?? ""),
  });

  if (!confirmation.ok) {
    await db
      .from("terminals")
      .update({ status: "pending", last_error: summarizeErrors(confirmation) })
      .eq("id", terminalUid);
    return errorResponse(502, "confirmation_failed", summarizeErrors(confirmation), {
      mra_status_code: confirmation.statusCode,
      mra_errors: confirmation.errors,
    });
  }

  await db
    .from("terminals")
    .update({
      status: "active",
      confirmed_at: new Date().toISOString(),
      is_blocked: false,
      blocking_message: null,
      last_error: null,
    })
    .eq("id", terminalUid);

  if (input.taxpayer_tin) {
    await db.from("tenants").update({ taxpayer_tin: input.taxpayer_tin }).eq("id", ctx.tenantId);
  } else {
    const tin = (
      (activation.data?.configuration?.["taxpayerConfiguration"] as Record<string, unknown>) ?? {}
    )["tin"];
    if (typeof tin === "string" && tin) {
      await db.from("tenants").update({ taxpayer_tin: tin }).eq("id", ctx.tenantId);
    }
  }

  return json({
    activated: true,
    confirmed: true,
    terminal_uid: terminalUid,
    terminal_id: input.terminal_id,
    mra_terminal_id: activated.terminalId,
    taxpayer_id: activated.taxpayerId ?? null,
    terminal_position: activated.terminalPosition ?? 1,
    store_id: input.store_id,
    mode: env.mode,
  });
}

/* -------------------------------------------------------------- inventory */

const inventorySchema = z.object({
  items: z
    .array(
      z.object({
        local_sku: z.string().min(1).max(120),
        mra_product_id: z.string().max(120).nullable().optional(),
        description: z.string().max(240).optional(),
        product_type: z.enum(["product", "service"]).default("product"),
        tax_rate_id: z.string().max(20).optional(),
        unit_of_measure: z.string().max(40).optional(),
        quantity_on_hand: z.number().optional(),
        informal_purchase: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(2000),
});

export async function handleInventorySync(request: Request): Promise<Response> {
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

  const parsed = inventorySchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, "invalid_payload", "Inventory payload failed validation", {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }

  const rows = parsed.data.items.map((item) => ({
    tenant_id: ctx.tenantId,
    local_sku: item.local_sku,
    mra_product_id: item.mra_product_id ?? null,
    description: item.description ?? null,
    product_type: item.product_type,
    tax_rate_id: item.tax_rate_id ?? null,
    unit_of_measure: item.unit_of_measure ?? null,
    quantity_on_hand: item.product_type === "product" ? (item.quantity_on_hand ?? null) : null,
    informal_purchase: item.informal_purchase,
    auto_registered: false,
  }));

  const { error } = await db
    .from("product_maps")
    .upsert(rows, { onConflict: "tenant_id,local_sku" });

  if (error) return errorResponse(500, "persist_failed", error.message);

  return json({
    synced: rows.length,
    unmapped: rows.filter((r) => !r.mra_product_id).map((r) => r.local_sku),
  });
}

/**
 * Pulls the MRA-registered product catalogue for a terminal's site
 * (utilities/get-terminal-site-products) and mirrors it into product_maps so
 * invoices only ever quote product codes MRA recognises.
 */
export async function handleProductPull(request: Request): Promise<Response> {
  const env = readEnv();
  const db = await getDb();

  const auth = await authenticateTenant(db, request);
  if (!auth.ok) return auth.response;
  const ctx = auth.context;

  const terminalKey = request.headers.get("x-terminal-id");
  if (!terminalKey) {
    return errorResponse(400, "missing_terminal", "X-Terminal-ID header is required");
  }

  const { data: terminal } = await db
    .from("terminals")
    .select(TERMINAL_COLUMNS)
    .eq("tenant_id", ctx.tenantId)
    .eq("terminal_id", terminalKey)
    .maybeSingle<TerminalRow>();

  if (!terminal) {
    return errorResponse(404, "unknown_terminal", `Terminal ${terminalKey} is not registered`);
  }

  const credentials = await loadCredentials(db, env, terminal.id);
  if (!credentials) {
    return errorResponse(409, "terminal_inactive", "Terminal credentials are missing");
  }

  const config = terminal.config ?? {};
  const taxpayer = (config["taxpayerConfiguration"] ?? {}) as Record<string, unknown>;
  const terminalConfig = (config["terminalConfiguration"] ?? {}) as Record<string, unknown>;
  const site = (terminalConfig["terminalSite"] ?? {}) as Record<string, unknown>;

  const payload = {
    tin: (taxpayer["tin"] as string) ?? "",
    siteId: (site["siteId"] as string) ?? terminal.store_id,
  };

  const result = await callMra<
    Array<{
      productCode?: string;
      productName?: string;
      description?: string;
      quantity?: number;
      unitOfMeasure?: string;
      taxRateId?: string;
      isProduct?: boolean;
    }>
  >({
    env,
    path: MRA_PATHS.terminalSiteProducts,
    payload,
    auth: { jwtToken: credentials.jwtToken },
    timeoutMs: 20_000,
  });

  await logMraCall(db, {
    tenantId: ctx.tenantId,
    terminalUid: terminal.id,
    endpoint: MRA_PATHS.terminalSiteProducts,
    statusCode: result.httpStatus,
    durationMs: result.durationMs,
    ok: result.ok,
    request: canonicalJson(payload),
    response: result.raw || (result.error ?? ""),
  });

  if (!result.ok) {
    return errorResponse(502, "product_pull_failed", summarizeErrors(result), {
      mra_status_code: result.statusCode,
      mra_http_status: result.httpStatus,
    });
  }

  const products = (result.data ?? []).filter((p) => p.productCode);
  if (products.length > 0) {
    await db.from("product_maps").upsert(
      products.map((p) => ({
        tenant_id: ctx.tenantId,
        local_sku: p.productCode!,
        mra_product_id: p.productCode!,
        description: p.description ?? p.productName ?? p.productCode!,
        product_type: p.isProduct === false ? "service" : "product",
        tax_rate_id: p.taxRateId ?? null,
        unit_of_measure: p.unitOfMeasure ?? null,
        quantity_on_hand: p.isProduct === false ? null : (p.quantity ?? null),
        auto_registered: false,
      })),
      { onConflict: "tenant_id,local_sku" },
    );
  }

  return json({
    site_id: payload.siteId,
    imported: products.length,
    products: products.map((p) => ({
      product_code: p.productCode,
      description: p.description ?? p.productName,
      tax_rate_id: p.taxRateId,
      is_product: p.isProduct !== false,
      quantity: p.quantity,
    })),
  });
}



/* ----------------------------------------------------------- queue worker */

export async function handleQueueWorker(): Promise<Response> {
  const env = readEnv();
  const db = await getDb();

  const { data: jobs, error } = await db.rpc("claim_sync_jobs", { _limit: 25 });
  if (error) return errorResponse(500, "claim_failed", error.message);

  const claimed = (jobs ?? []) as Array<{
    id: number;
    tenant_id: string;
    invoice_id: string;
    attempts: number;
  }>;

  let submitted = 0;
  let requeued = 0;
  let dead = 0;

  for (const job of claimed) {
    const { data: invoice } = await db
      .from("invoices")
      .select("id, tenant_id, terminal_uid, mra_payload, mra_invoice_number, grand_total")
      .eq("id", job.invoice_id)
      .maybeSingle();

    if (!invoice || !invoice["terminal_uid"]) {
      await db
        .from("sync_queue")
        .update({ status: "dead", last_error: "Invoice missing" })
        .eq("id", job.id);
      dead += 1;
      continue;
    }

    const { data: tenant } = await db
      .from("tenants")
      .select("rate_limit_per_min")
      .eq("id", job.tenant_id)
      .maybeSingle();

    const allowed = await checkRateLimit(
      db,
      job.tenant_id,
      Number(tenant?.["rate_limit_per_min"] ?? 300),
    );
    if (!allowed) {
      await db
        .from("sync_queue")
        .update({ status: "queued", run_after: new Date(Date.now() + 10_000).toISOString() })
        .eq("id", job.id);
      requeued += 1;
      continue;
    }

    const terminalUid = invoice["terminal_uid"] as string;
    const credentials = await loadCredentials(db, env, terminalUid);
    if (!credentials) {
      await db
        .from("sync_queue")
        .update({ status: "dead", last_error: "Terminal credentials missing" })
        .eq("id", job.id);
      dead += 1;
      continue;
    }

    const outcome = await submitInvoiceToMra({
      db,
      env,
      tenantId: job.tenant_id,
      terminalUid,
      payload: invoice["mra_payload"] as Record<string, unknown>,
      credentials,
      timeoutMs: 15_000,
    });

    if (outcome.shouldDownloadLatestConfig) {
      await refreshConfiguration(
        db,
        env,
        { id: terminalUid, tenant_id: job.tenant_id },
        credentials.jwtToken,
      );
    }
    if (outcome.shouldBlockTerminal) {
      await captureBlockingMessage(
        db,
        env,
        { id: terminalUid, tenant_id: job.tenant_id },
        credentials.jwtToken,
      );
    }

    if (outcome.submitted) {
      await db
        .from("invoices")
        .update({
          status: "SUBMITTED",
          mra_invoice_id: invoice["mra_invoice_number"],
          validation_url: outcome.validationUrl,
          mra_response: outcome.response as Record<string, unknown>,
          submitted_at: new Date().toISOString(),
          attempts: job.attempts,
          last_error: null,
        })
        .eq("id", invoice["id"]);
      await db.from("sync_queue").delete().eq("id", job.id);
      // Free the offline allowance now that MRA has the transaction.
      const { data: term } = await db
        .from("terminals")
        .select("offline_accumulated")
        .eq("id", terminalUid)
        .maybeSingle();
      await db
        .from("terminals")
        .update({
          offline_accumulated: Math.max(
            0,
            Number(term?.["offline_accumulated"] ?? 0) - Number(invoice["grand_total"] ?? 0),
          ),
        })
        .eq("id", terminalUid);
      submitted += 1;
      continue;
    }

    if (outcome.rejected || job.attempts >= 10) {
      await db
        .from("invoices")
        .update({
          status: outcome.rejected ? "REJECTED" : "FAILED",
          mra_response: outcome.response as Record<string, unknown>,
          attempts: job.attempts,
          last_error: outcome.error,
        })
        .eq("id", invoice["id"]);
      await db
        .from("sync_queue")
        .update({ status: "dead", last_error: outcome.error })
        .eq("id", job.id);
      dead += 1;
      continue;
    }

    const backoffSeconds = Math.min(300, 15 * job.attempts);
    await db
      .from("sync_queue")
      .update({
        status: "queued",
        last_error: outcome.error,
        run_after: new Date(Date.now() + backoffSeconds * 1000).toISOString(),
      })
      .eq("id", job.id);
    await db
      .from("invoices")
      .update({ attempts: job.attempts, last_error: outcome.error })
      .eq("id", invoice["id"]);
    requeued += 1;
  }

  return json({ claimed: claimed.length, submitted, requeued, dead });
}

/* ------------------------------------------------------------ config sync */

/**
 * Returns the current MRA configuration for a terminal, including available
 * tax rates, taxpayer info, and terminal settings. This endpoint lets ERP/POS
 * systems auto-discover tax rates and stay in sync with the middleware.
 */
export async function handleGetConfig(request: Request): Promise<Response> {
  const env = readEnv();
  const db = await getDb();

  const auth = await authenticateTenant(db, request);
  if (!auth.ok) return auth.response;
  const ctx = auth.context;

  const terminalKey = request.headers.get("x-terminal-id");
  if (!terminalKey) {
    return errorResponse(400, "missing_terminal", "X-Terminal-ID header is required");
  }

  const { data: terminal } = await db
    .from("terminals")
    .select(TERMINAL_COLUMNS)
    .eq("tenant_id", ctx.tenantId)
    .eq("terminal_id", terminalKey)
    .maybeSingle<TerminalRow>();

  if (!terminal) {
    return errorResponse(404, "unknown_terminal", `Terminal ${terminalKey} is not registered`);
  }

  const config = terminal.config ?? {};
  const global = (config["globalConfiguration"] ?? {}) as Record<string, unknown>;
  const taxpayer = (config["taxpayerConfiguration"] ?? {}) as Record<string, unknown>;
  const terminalCfg = (config["terminalConfiguration"] ?? {}) as Record<string, unknown>;
  const site = (terminalCfg["terminalSite"] ?? {}) as Record<string, unknown>;
  const rates = (global["taxrates"] ?? global["taxRates"] ?? []) as Array<Record<string, unknown>>;

  const { data: tenantRow } = await db
    .from("tenants")
    .select("taxpayer_tin")
    .eq("id", ctx.tenantId)
    .maybeSingle();

  return json({
    terminal_id: terminal.terminal_id,
    terminal_uid: terminal.id,
    status: terminal.status,
    site_id: site["siteId"] ?? terminal.store_id,
    site_name: site["siteName"] ?? terminal.store_id,
    taxpayer_tin: tenantRow?.["taxpayer_tin"] ?? taxpayer["tin"] ?? null,
    is_vat_registered: taxpayer["isVATRegistered"] !== false,
    tax_rates: rates.map((r) => ({
      id: String(r["id"]),
      name: String(r["name"] ?? ""),
      rate: Number(r["rate"] ?? 0),
      charge_mode: String(r["chargeMode"] ?? "Item"),
    })),
    default_tax_rate_id: defaultTaxRateId(config),
    offline_limit: {
      max_cumulative_amount: terminal.offline_max_amount,
      max_transaction_age_hours: terminal.offline_max_age_hours,
      accumulated: terminal.offline_accumulated,
    },
    config_version: {
      global: terminal.global_config_version,
      taxpayer: terminal.taxpayer_config_version,
      terminal: terminal.terminal_config_version,
    },
    last_config_sync_at: terminal.last_config_sync_at ?? null,
    mode: env.mode,
  });
}

export async function handleConfigSync(): Promise<Response> {
  const env = readEnv();
  const db = await getDb();

  const { data: terminals } = await db
    .from("terminals")
    .select("id, tenant_id, terminal_id")
    .eq("status", "active")
    .limit(500);

  let updated = 0;
  let failed = 0;

  for (const terminal of terminals ?? []) {
    const credentials = await loadCredentials(db, env, terminal["id"] as string);
    if (!credentials) {
      failed += 1;
      continue;
    }

    const ok = await refreshConfiguration(
      db,
      env,
      { id: terminal["id"] as string, tenant_id: terminal["tenant_id"] as string },
      credentials.jwtToken,
    );
    if (ok) updated += 1;
    else failed += 1;
  }

  return json({ terminals: (terminals ?? []).length, updated, failed });
}

/* ------------------------------------------------------------ api tokens */

export async function issueApiToken(
  db: SupabaseClient,
  tenantId: string,
  label: string,
  expiresInDays = 365,
) {
  const { token, hash, prefix } = await mintApiToken();
  const expiresAt = new Date(Date.now() + expiresInDays * 86400_000).toISOString();
  const { error } = await db
    .from("api_tokens")
    .insert({ tenant_id: tenantId, label, token_hash: hash, token_prefix: prefix, expires_at: expiresAt });
  if (error) throw new Error(error.message);
  return token;
}

/* -------------------------------------------------- missing MRA endpoints */

async function resolveTerminal(request: Request, tenantId: string) {
  const terminalKey = request.headers.get("x-terminal-id");
  if (!terminalKey) return { error: errorResponse(400, "missing_terminal", "X-Terminal-ID header is required") };
  const db = await getDb();
  const { data: terminal } = await db
    .from("terminals")
    .select(TERMINAL_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("terminal_id", terminalKey)
    .maybeSingle();
  if (!terminal) return { error: errorResponse(404, "unknown_terminal", `Terminal ${terminalKey} is not registered`) };
  if (terminal.status !== "active") return { error: errorResponse(409, "terminal_inactive", `Terminal ${terminalKey} is not active`) };
  const env = readEnv();
  const credentials = await loadCredentials(db, env, terminal.id);
  if (!credentials) return { error: errorResponse(409, "terminal_inactive", "Terminal credentials missing") };
  return { terminal, credentials, env, db };
}

export async function handlePing(request: Request): Promise<Response> {
  const auth = await authenticateTenant(await getDb(), request);
  if (!auth.ok) return auth.response;
  const r = await resolveTerminal(request, auth.context.tenantId);
  if ("error" in r) return r.error;
  const result = await callMra({ env: r.env, path: MRA_PATHS.ping, payload: {}, auth: { jwtToken: r.credentials.jwtToken } });
  if (!result.ok) return errorResponse(502, "mra_rejection", summarizeErrors(result), result.errors);
  return json(result.data ?? { status: "pong" });
}

export async function handleLastSubmittedOnline(request: Request): Promise<Response> {
  const auth = await authenticateTenant(await getDb(), request);
  if (!auth.ok) return auth.response;
  const r = await resolveTerminal(request, auth.context.tenantId);
  if ("error" in r) return r.error;
  const body = await request.json().catch(() => ({}));
  const result = await callMra({ env: r.env, path: MRA_PATHS.lastSubmittedOnline, payload: body, auth: { jwtToken: r.credentials.jwtToken } });
  if (!result.ok) return errorResponse(502, "mra_rejection", summarizeErrors(result), result.errors);
  return json(result.data ?? {});
}

export async function handleLastSubmittedOffline(request: Request): Promise<Response> {
  const auth = await authenticateTenant(await getDb(), request);
  if (!auth.ok) return auth.response;
  const r = await resolveTerminal(request, auth.context.tenantId);
  if ("error" in r) return r.error;
  const body = await request.json().catch(() => ({}));
  const result = await callMra({ env: r.env, path: MRA_PATHS.lastSubmittedOffline, payload: body, auth: { jwtToken: r.credentials.jwtToken } });
  if (!result.ok) return errorResponse(502, "mra_rejection", summarizeErrors(result), result.errors);
  return json(result.data ?? {});
}

export async function handleCancelReceipt(request: Request): Promise<Response> {
  const auth = await authenticateTenant(await getDb(), request);
  if (!auth.ok) return auth.response;
  const r = await resolveTerminal(request, auth.context.tenantId);
  if ("error" in r) return r.error;
  let raw: unknown;
  try { raw = await request.json(); } catch { return errorResponse(400, "invalid_json", "Request body is not valid JSON"); }
  const result = await callMra({ env: r.env, path: MRA_PATHS.cancelReceipt, payload: raw, auth: { jwtToken: r.credentials.jwtToken } });
  await logMraCall(r.db, { tenantId: auth.context.tenantId, terminalUid: r.terminal.id, endpoint: MRA_PATHS.cancelReceipt, statusCode: result.httpStatus, durationMs: result.durationMs, ok: result.ok, request: JSON.stringify(raw), response: result.raw });
  if (!result.ok) return errorResponse(502, "mra_rejection", summarizeErrors(result), result.errors);
  return json(result.data ?? { status: "cancelled" });
}

export async function handleGetVoidReceipts(request: Request): Promise<Response> {
  const auth = await authenticateTenant(await getDb(), request);
  if (!auth.ok) return auth.response;
  const r = await resolveTerminal(request, auth.context.tenantId);
  if ("error" in r) return r.error;
  const result = await callMra({ env: r.env, path: MRA_PATHS.getVoidReceipts, payload: {}, auth: { jwtToken: r.credentials.jwtToken } });
  if (!result.ok) return errorResponse(502, "mra_rejection", summarizeErrors(result), result.errors);
  return json(result.data ?? { voids: [] });
}

export async function handleTerminalActivatedConfirmation(request: Request): Promise<Response> {
  let raw: unknown;
  try { raw = await request.json(); } catch { return errorResponse(400, "invalid_json", "Request body is not valid JSON"); }
  const env = readEnv();
  const db = await getDb();
  const terminalKey = request.headers.get("x-terminal-id");
  if (!terminalKey) return errorResponse(400, "missing_terminal", "X-Terminal-ID header is required");
  const { data: terminal } = await db.from("terminals").select(TERMINAL_COLUMNS).eq("terminal_id", terminalKey).maybeSingle();
  if (!terminal) return errorResponse(404, "unknown_terminal", "Terminal not found");
  const credentials = await loadCredentials(db, env, terminal.id);
  if (!credentials) return errorResponse(409, "terminal_inactive", "Terminal credentials missing");
  const typedRaw = raw as Record<string, unknown>;
  const signature = await hmacSha512Base64(env.masterKey, (typedRaw["tac"] as string) ?? "");
  const result = await callMra({ env, path: MRA_PATHS.terminalActivatedConfirmation, payload: typedRaw, auth: { jwtToken: credentials.jwtToken, xSignature: signature } });
  if (!result.ok) return errorResponse(502, "mra_rejection", summarizeErrors(result), result.errors);
  return json(result.data ?? { status: "confirmed" });
}

export async function handleRequestNewTerminalToken(request: Request): Promise<Response> {
  const auth = await authenticateTenant(await getDb(), request);
  if (!auth.ok) return auth.response;
  const r = await resolveTerminal(request, auth.context.tenantId);
  if ("error" in r) return r.error;
  const result = await callMra({ env: r.env, path: MRA_PATHS.requestNewTerminalToken, payload: {}, auth: { jwtToken: r.credentials.jwtToken } });
  if (!result.ok) return errorResponse(502, "mra_rejection", summarizeErrors(result), result.errors);
  return json(result.data ?? {});
}

export async function handleValidateVat5(request: Request): Promise<Response> {
  const auth = await authenticateTenant(await getDb(), request);
  if (!auth.ok) return auth.response;
  const r = await resolveTerminal(request, auth.context.tenantId);
  if ("error" in r) return r.error;
  let raw: unknown;
  try { raw = await request.json(); } catch { return errorResponse(400, "invalid_json", "Request body is not valid JSON"); }
  const result = await callMra({ env: r.env, path: MRA_PATHS.validateVat5, payload: raw, auth: { jwtToken: r.credentials.jwtToken } });
  if (!result.ok) return errorResponse(502, "mra_rejection", summarizeErrors(result), result.errors);
  return json(result.data ?? {});
}

export async function handleTerminalBlockingMessage(request: Request): Promise<Response> {
  const auth = await authenticateTenant(await getDb(), request);
  if (!auth.ok) return auth.response;
  const r = await resolveTerminal(request, auth.context.tenantId);
  if ("error" in r) return r.error;
  const result = await callMra({ env: r.env, path: MRA_PATHS.terminalBlockingMessage, payload: {}, auth: { jwtToken: r.credentials.jwtToken } });
  if (!result.ok) return errorResponse(502, "mra_rejection", summarizeErrors(result), result.errors);
  return json(result.data ?? {});
}

export async function handleCheckTerminalUnblockStatus(request: Request): Promise<Response> {
  const auth = await authenticateTenant(await getDb(), request);
  if (!auth.ok) return auth.response;
  const r = await resolveTerminal(request, auth.context.tenantId);
  if ("error" in r) return r.error;
  const result = await callMra({ env: r.env, path: MRA_PATHS.checkTerminalUnblockStatus, payload: {}, auth: { jwtToken: r.credentials.jwtToken } });
  if (!result.ok) return errorResponse(502, "mra_rejection", summarizeErrors(result), result.errors);
  return json(result.data ?? {});
}

export async function handleGetUnitsOfMeasure(request: Request): Promise<Response> {
  const auth = await authenticateTenant(await getDb(), request);
  if (!auth.ok) return auth.response;
  const r = await resolveTerminal(request, auth.context.tenantId);
  if ("error" in r) return r.error;
  const result = await callMra({ env: r.env, path: MRA_PATHS.getUnitsOfMeasure, payload: {}, auth: { jwtToken: r.credentials.jwtToken } });
  if (!result.ok) return errorResponse(502, "mra_rejection", summarizeErrors(result), result.errors);
  return json(result.data ?? { units: [] });
}

export async function handleGetRawMaterial(request: Request): Promise<Response> {
  const auth = await authenticateTenant(await getDb(), request);
  if (!auth.ok) return auth.response;
  const r = await resolveTerminal(request, auth.context.tenantId);
  if ("error" in r) return r.error;
  let raw: unknown;
  try { raw = await request.json(); } catch { raw = {}; }
  const result = await callMra({ env: r.env, path: MRA_PATHS.getRawMaterial, payload: raw, auth: { jwtToken: r.credentials.jwtToken } });
  if (!result.ok) return errorResponse(502, "mra_rejection", summarizeErrors(result), result.errors);
  return json(result.data ?? {});
}

export async function handleSubmitInformalPurchase(request: Request): Promise<Response> {
  const auth = await authenticateTenant(await getDb(), request);
  if (!auth.ok) return auth.response;
  const r = await resolveTerminal(request, auth.context.tenantId);
  if ("error" in r) return r.error;
  let raw: unknown;
  try { raw = await request.json(); } catch { return errorResponse(400, "invalid_json", "Request body is not valid JSON"); }
  const result = await callMra({ env: r.env, path: MRA_PATHS.submitInformalPurchase, payload: raw, auth: { jwtToken: r.credentials.jwtToken } });
  await logMraCall(r.db, { tenantId: auth.context.tenantId, terminalUid: r.terminal.id, endpoint: MRA_PATHS.submitInformalPurchase, statusCode: result.httpStatus, durationMs: result.durationMs, ok: result.ok, request: JSON.stringify(raw), response: result.raw });
  if (!result.ok) return errorResponse(502, "mra_rejection", summarizeErrors(result), result.errors);
  return json(result.data ?? { status: "submitted" });
}
