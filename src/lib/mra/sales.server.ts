/**
 * Sales pipeline — builds the official `SalesInvoice` payload
 * (invoiceHeader / invoiceLineItems / invoiceSummary) defined by the
 * MRA EIS API v1 Developers Guide, section 5.3.1.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import {
  base10ToBase64,
  canonicalJson,
  hmacSha256Base64Url,
  formatMraDateTime,
  openSecret,
  toMalawiJulianDate,
} from "./crypto.server";
import type { MraEnv } from "./env.server";
import { callMra, MRA_PATHS, summarizeErrors } from "./mra-client.server";

/* ------------------------------------------------------------- ERP schema */

export const lineItemSchema = z.object({
  erp_sku: z.string().min(1).max(120),
  description: z.string().max(240).optional(),
  quantity: z.number().positive().max(1_000_000),
  unit_price: z.number().nonnegative().max(1_000_000_000),
  discount: z.number().nonnegative().max(1_000_000_000).optional(),
  /** Official MRA tax rate id from the terminal configuration (e.g. "A", "T", "E"). */
  tax_rate_id: z.string().max(20).optional(),
  is_product: z.boolean().optional(),
});

export const vat5Schema = z.object({
  id: z.number().int().optional(),
  project_number: z.string().max(80).optional(),
  certificate_number: z.string().max(80).optional(),
  quantity: z.number().nonnegative().optional(),
});

export const salesSchema = z.object({
  erp_invoice_number: z.string().min(1).max(120),
  cashier_id: z.string().max(80).optional(),
  customer_tin: z.string().max(40).optional(),
  buyer_name: z.string().max(160).optional(),
  buyer_authorization_code: z.string().max(80).optional(),
  payment_method: z.string().max(40).default("Cash"),
  amount_tendered: z.number().nonnegative().optional(),
  is_export: z.boolean().optional(),
  is_relief_supply: z.boolean().optional(),
  vat5_certificate: vat5Schema.optional(),
  invoice_timestamp: z.string().max(40).optional(),
  is_offline: z.boolean().optional(),
  line_items: z.array(lineItemSchema).min(1).max(500),
});

export type SalesInput = z.infer<typeof salesSchema>;

/* ---------------------------------------------------------------- helpers */

export interface TerminalRow {
  id: string;
  tenant_id: string;
  store_id: string;
  terminal_id: string;
  mra_terminal_ref: string | null;
  status: string;
  config: Record<string, unknown>;
  taxpayer_id: number | null;
  terminal_position: number | null;
  global_config_version: number;
  taxpayer_config_version: number;
  terminal_config_version: number;
  is_blocked: boolean;
  offline_max_age_hours: number;
  offline_max_amount: number;
  offline_accumulated: number;
  last_config_sync_at: string | null;
}

export interface TerminalCredentials {
  /** Bearer JWT issued in the activation response. */
  jwtToken: string | null;
  /** Secret key issued in the activation response. */
  secretKey: string;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Reads a tax rate percentage from the cached MRA global configuration. */
export function resolveTaxRate(config: Record<string, unknown>, rateId: string): number {
  const global = (config?.["globalConfiguration"] ?? {}) as Record<string, unknown>;
  const rates = ((global["taxrates"] ?? global["taxRates"] ?? []) as Array<Record<string, unknown>>);
  const match = rates.find((r) => String(r["id"]).toUpperCase() === rateId.toUpperCase());
  const rate = match ? Number(match["rate"] ?? 0) : 0;
  return Number.isFinite(rate) ? rate : 0;
}

/** Whether the taxpayer is VAT-registered per MRA configuration. */
export function isTaxpayerVatRegistered(config: Record<string, unknown>): boolean {
  const taxpayer = (config?.["taxpayerConfiguration"] ?? {}) as Record<string, unknown>;
  return taxpayer["isVATRegistered"] !== false;
}

/** Default rate id when the ERP or product map does not supply one. */
export function defaultTaxRateId(config: Record<string, unknown>): string {
  const global = (config?.["globalConfiguration"] ?? {}) as Record<string, unknown>;
  const rates = ((global["taxrates"] ?? global["taxRates"] ?? []) as Array<Record<string, unknown>>);
  const taxpayer = (config?.["taxpayerConfiguration"] ?? {}) as Record<string, unknown>;
  const activated = (taxpayer["activatedTaxRateIds"] ?? []) as string[];

  // Non-VAT-registered taxpayers must not charge VAT: always use a 0% rate.
  if (taxpayer["isVATRegistered"] === false) {
    const zero = rates.find((r) => Number(r["rate"] ?? 0) === 0);
    if (zero) return String(zero["id"]);
  }

  // Prefer a rate the taxpayer is actually activated for and that exists globally.
  const activatedGlobal = rates.find((r) =>
    activated.some((id) => String(id).toUpperCase() === String(r["id"]).toUpperCase()),
  );
  if (activatedGlobal) return String(activatedGlobal["id"]);

  const vat = rates.find((r) => String(r["name"] ?? "").toUpperCase().includes("VAT"));
  return String(vat?.["id"] ?? rates[0]?.["id"] ?? "A");
}

/**
 * Resolves the effective tax rate id for a line item.
 * When the taxpayer is not VAT-registered, forces a 0% rate regardless of what
 * the ERP or product map specifies — the middleware enforces tax compliance.
 */
export function resolveEffectiveRateId(
  config: Record<string, unknown>,
  itemRateId: string | undefined,
  mappedRateId: string | null | undefined,
): string {
  if (!isTaxpayerVatRegistered(config)) {
    return defaultTaxRateId(config);
  }
  return (itemRateId ?? mappedRateId ?? defaultTaxRateId(config)).toUpperCase();
}

/** Official MRA site id from the terminal configuration (falls back to the local store id). */
export function resolveSiteId(config: Record<string, unknown>, fallback: string): string {
  const terminal = (config?.["terminalConfiguration"] ?? {}) as Record<string, unknown>;
  const site = (terminal["terminalSite"] ?? {}) as Record<string, unknown>;
  const siteId = site["siteId"];
  return typeof siteId === "string" && siteId ? siteId : fallback;
}

export async function loadCredentials(
  db: SupabaseClient,
  env: MraEnv,
  terminalUid: string,
): Promise<TerminalCredentials | null> {
  const { data } = await db
    .from("terminal_secrets")
    .select("secret_key_enc, session_token_enc")
    .eq("terminal_uid", terminalUid)
    .maybeSingle();

  if (!data) return null;
  return {
    secretKey: await openSecret(data.secret_key_enc, env.masterKey),
    jwtToken: data.session_token_enc
      ? await openSecret(data.session_token_enc, env.masterKey)
      : null,
  };
}

export async function logMraCall(
  db: SupabaseClient,
  entry: {
    tenantId: string | null;
    terminalUid?: string | null;
    endpoint: string;
    statusCode: number;
    durationMs: number;
    ok: boolean;
    request: string;
    response: string;
  },
) {
  await db.from("mra_logs").insert({
    tenant_id: entry.tenantId,
    terminal_uid: entry.terminalUid ?? null,
    endpoint: entry.endpoint,
    status_code: entry.statusCode,
    duration_ms: entry.durationMs,
    ok: entry.ok,
    request_body: entry.request.slice(0, 8000),
    response_body: entry.response.slice(0, 8000),
  });
}

/* ------------------------------------------------------------- SKU mapping */

export interface MappingResolution {
  ok: boolean;
  unmapped: string[];
  bySku: Map<
    string,
    {
      mra_product_id: string | null;
      product_type: string;
      tax_rate_id: string | null;
      description: string | null;
    }
  >;
}

/**
 * Resolves every SKU on the invoice against the tenant's compliance map.
 * MRA rejects any product code (or description) that is not registered for the
 * site, so unmapped SKUs are always a hard failure — in UAT and in production.
 */
export async function resolveMappings(
  db: SupabaseClient,
  _env: MraEnv,
  tenantId: string,
  items: SalesInput["line_items"],
): Promise<MappingResolution> {
  const skus = [...new Set(items.map((i) => i.erp_sku))];
  const { data } = await db
    .from("product_maps")
    .select("local_sku, mra_product_id, product_type, tax_rate_id, description")
    .eq("tenant_id", tenantId)
    .in("local_sku", skus);

  const bySku: MappingResolution["bySku"] = new Map(
    (data ?? []).map((row) => [
      row.local_sku as string,
      {
        mra_product_id: row.mra_product_id as string | null,
        product_type: row.product_type as string,
        tax_rate_id: (row.tax_rate_id as string | null) ?? null,
        description: (row.description as string | null) ?? null,
      },
    ]),
  );

  const unmapped = skus.filter((sku) => !bySku.get(sku)?.mra_product_id);
  return { ok: unmapped.length === 0, unmapped, bySku };
}


/* ------------------------------------------------------- invoice building */

/**
 * Invoice number (section 5.3.1.1.1):
 * Base64(TaxpayerID)-Base64(TerminalPosition)-Base64(JulianDate)-Base64(Count)
 */
export function generateInvoiceNumber(args: {
  taxpayerId: number;
  terminalPosition: number;
  transactionDate: Date;
  transactionCount: number;
}): string {
  const julian = toMalawiJulianDate(args.transactionDate);
  return [
    base10ToBase64(args.taxpayerId),
    base10ToBase64(args.terminalPosition),
    base10ToBase64(julian),
    base10ToBase64(args.transactionCount),
  ].join("-");
}

/**
 * Offline receipt signing (section 6.2): HMAC-SHA256 (Base64Url) over
 * `TI=<invoiceNumber>&N=<items>&I=<total>&V=<vat>&T=<julianBase64>`.
 */
export async function buildOfflineValidation(args: {
  env: MraEnv;
  secretKey: string;
  invoiceNumber: string;
  numItems: number;
  invoiceTotal: number;
  vatAmount: number;
  transactionDate: Date;
}): Promise<{ offlineSignature: string; validationUrl: string }> {
  const julianBase64 = base10ToBase64(toMalawiJulianDate(args.transactionDate));
  const param = `TI=${args.invoiceNumber}&N=${args.numItems}&I=${args.invoiceTotal}&V=${args.vatAmount}&T=${julianBase64}`;
  const offlineSignature = await hmacSha256Base64Url(args.secretKey, param);
  const validationUrl = `${args.env.validationBaseUrl}?${param}&S=${encodeURIComponent(offlineSignature)}`;
  return { offlineSignature, validationUrl };
}

export interface BuiltInvoice {
  payload: Record<string, unknown>;
  invoiceNumber: string;
  totalVat: number;
  invoiceTotal: number;
  numItems: number;
}

/** Translates the simplified ERP payload into the official SalesInvoice schema. */
export function buildSalesInvoice(args: {
  input: SalesInput;
  terminal: TerminalRow;
  sellerTin: string;
  invoiceNumber: string;
  invoiceDateTime: Date;
  mappings: MappingResolution["bySku"];
}): BuiltInvoice {
  const { input, terminal, sellerTin, invoiceNumber, invoiceDateTime, mappings } = args;
  const config = terminal.config ?? {};
  const fallbackRateId = defaultTaxRateId(config);

  let totalVat = 0;
  let invoiceTotal = 0;
  const taxTotals = new Map<string, { taxableAmount: number; taxAmount: number }>();

  const invoiceLineItems = input.line_items.map((item, index) => {
    const mapped = mappings.get(item.erp_sku);
    const rateId = resolveEffectiveRateId(config, item.tax_rate_id, mapped?.tax_rate_id);
    const rate = resolveTaxRate(config, rateId);

    // MRA prices are VAT-inclusive: `total` is what the customer pays and the
    // tax breakdown must reconcile as taxableAmount = total - totalVAT.
    const total = round2(item.quantity * item.unit_price - (item.discount ?? 0));
    const lineVat = round2((total * rate) / (100 + rate));
    const taxable = round2(total - lineVat);

    totalVat = round2(totalVat + lineVat);
    invoiceTotal = round2(invoiceTotal + total);

    const bucket = taxTotals.get(rateId) ?? { taxableAmount: 0, taxAmount: 0 };
    bucket.taxableAmount = round2(bucket.taxableAmount + taxable);
    bucket.taxAmount = round2(bucket.taxAmount + lineVat);
    taxTotals.set(rateId, bucket);

    return {
      id: index + 1,
      productCode: mapped?.mra_product_id ?? item.erp_sku,
      // MRA rejects a description that differs from the registered product's.
      description: mapped?.description ?? item.description ?? item.erp_sku,
      unitPrice: round2(item.unit_price),
      quantity: item.quantity,
      discount: item.discount ?? 0,
      total,
      totalVAT: lineVat,
      taxRateId: rateId,
      isProduct: item.is_product ?? mapped?.product_type !== "service",
    };
  });


  const invoiceHeader: Record<string, unknown> = {
    invoiceNumber,
    invoiceDateTime: formatMraDateTime(invoiceDateTime),
    sellerTIN: sellerTin,
    buyerTIN: input.customer_tin ?? null,
    buyerName: input.buyer_name ?? null,
    buyerAuthorizationCode: input.buyer_authorization_code ?? null,
    siteId: resolveSiteId(config, terminal.store_id),
    globalConfigVersion: terminal.global_config_version,
    taxpayerConfigVersion: terminal.taxpayer_config_version,
    terminalConfigVersion: terminal.terminal_config_version,
    isExport: input.is_export ?? false,
    isReliefSupply: input.is_relief_supply ?? false,
    paymentMethod: input.payment_method,
  };

  if (input.vat5_certificate) {
    invoiceHeader["vat5CertificateDetails"] = {
      id: input.vat5_certificate.id ?? 0,
      projectNumber: input.vat5_certificate.project_number ?? null,
      certificateNumber: input.vat5_certificate.certificate_number ?? null,
      quantity: input.vat5_certificate.quantity ?? 0,
    };
  }

  const invoiceSummary: Record<string, unknown> = {
    taxBreakDown: [...taxTotals.entries()].map(([rateId, totals]) => ({
      rateId,
      taxableAmount: totals.taxableAmount,
      taxAmount: totals.taxAmount,
    })),
    levyBreakDown: [],
    totalVAT: totalVat,
    invoiceTotal,
    amountTendered: input.amount_tendered ?? invoiceTotal,
    offlineSignature: null,
  };

  return {
    payload: { invoiceHeader, invoiceLineItems, invoiceSummary },
    invoiceNumber,
    totalVat,
    invoiceTotal,
    numItems: invoiceLineItems.length,
  };
}

/* ----------------------------------------------------------- transmission */

export interface SubmitOutcome {
  submitted: boolean;
  httpStatus: number;
  statusCode: number | null;
  validationUrl: string | null;
  shouldDownloadLatestConfig: boolean;
  shouldBlockTerminal: boolean;
  response: unknown;
  error: string | null;
  rejected: boolean;
}

/** Signs and pushes one stored invoice to MRA. Used online and by the queue worker. */
export async function submitInvoiceToMra(args: {
  db: SupabaseClient;
  env: MraEnv;
  tenantId: string;
  terminalUid: string | null;
  payload: Record<string, unknown>;
  credentials: TerminalCredentials;
  timeoutMs?: number;
}): Promise<SubmitOutcome> {
  const { db, env, tenantId, terminalUid, payload, credentials } = args;
  const path = MRA_PATHS.submitSalesTransaction;

  const result = await callMra<{
    validationURL?: string;
    shouldDownloadLatestConfig?: boolean;
    shouldBlockTerminal?: boolean;
    validationErrors?: string[];
  }>({
    env,
    path,
    payload,
    auth: { jwtToken: credentials.jwtToken },
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
  });

  await logMraCall(db, {
    tenantId,
    terminalUid,
    endpoint: path,
    statusCode: result.httpStatus,
    durationMs: result.durationMs,
    ok: result.ok,
    request: canonicalJson(payload),
    response: result.raw || (result.error ?? ""),
  });

  const shouldDownloadLatestConfig = result.data?.shouldDownloadLatestConfig === true;
  const shouldBlockTerminal = result.data?.shouldBlockTerminal === true;

  if (result.ok) {
    return {
      submitted: true,
      httpStatus: result.httpStatus,
      statusCode: result.statusCode,
      validationUrl: result.data?.validationURL ?? null,
      shouldDownloadLatestConfig,
      shouldBlockTerminal,
      response: result.data,
      error: null,
      rejected: false,
    };
  }

  // A business failure (statusCode < -1) or a 4xx means MRA rejected the
  // content; retrying will not help. Transport failures are retryable.
  const businessRejection =
    (result.statusCode !== null && result.statusCode < -1) ||
    (result.httpStatus >= 400 && result.httpStatus < 500 && result.httpStatus !== 429);

  return {
    submitted: false,
    httpStatus: result.httpStatus,
    statusCode: result.statusCode,
    validationUrl: null,
    shouldDownloadLatestConfig,
    shouldBlockTerminal,
    response: result.data ?? result.errors,
    error: summarizeErrors(result),
    rejected: businessRejection && result.httpStatus !== 401,
  };
}
