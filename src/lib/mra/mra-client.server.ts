/**
 * HTTP client for the MRA EIS API (https://eis-api.mra.mw).
 *
 * Header rules per the Developers Guide, section 4.1.1, and the official
 * open-source SDK (github.com/joelfickson/mra-sdk):
 *  - x-access-key : Vendor Access Key, required only for terminal activation in production.
 *  - x-signature  : Base64 HMAC-SHA512(TAC, secretKey), required only for activation confirmation.
 *  - Authorization: "Bearer <jwtToken>" for every other endpoint.
 *
 * NOTE: The MRA docs curl examples show raw JWT without Bearer prefix, but
 * section 4.1.1.3 explicitly says "Bearer Authorization jwtToken" and the
 * official SDK confirms Bearer prefix is required. Without it, MRA returns 401.
 *
 * Every response follows the envelope { statusCode, remark, data, errors }.
 * statusCode === 1 means success; anything < -1 is a business failure.
 */
import type { MraEnv } from "./env.server";
import { hmacSha512Base64 } from "./crypto.server";

export interface MraApiError {
  errorCode?: number;
  fieldName?: string | null;
  errorMessage?: string | null;
}

export interface MraCallResult<T = unknown> {
  /** True only when HTTP is 2xx AND the envelope statusCode is 1. */
  ok: boolean;
  httpStatus: number;
  statusCode: number | null;
  remark: string | null;
  data: T | null;
  errors: MraApiError[];
  raw: string;
  durationMs: number;
  timedOut: boolean;
  error?: string;
}

export interface MraAuth {
  /** Bearer JWT obtained from terminal activation. */
  jwtToken?: string | null;
  /** Base64 HMAC-SHA512 signature (activation confirmation only). */
  xSignature?: string | null;
  /** Vendor Access Key (production activation only). */
  accessKey?: string | null;
  /**
   * Terminal secret key. When present, every POST with a body (except
   * terminal activation) gets x-eis-message-hash =
   * Base64(HMAC-SHA512(body, secretKey)) per the Developers Guide section 4.1.1.
   */
  secretKey?: string | null;
}

export const MRA_PATHS = {
  activateTerminal: "/api/v1/onboarding/activate-terminal",
  terminalActivatedConfirmation: "/api/v1/onboarding/terminal-activated-confirmation",
  getLatestConfigs: "/api/v1/configuration/get-latest-configs",
  requestNewTerminalToken: "/api/v1/configuration/request-new-terminal-token",
  submitSalesTransaction: "/api/v1/sales/submit-sales-transaction",
  lastSubmittedOnline: "/api/v1/sales/last-submitted-online-transaction",
  lastSubmittedOffline: "/api/v1/sales/last-submitted-offline-transaction",
  getInvoiceByNumber: "/api/v1/sales/get-invoice-by-number",
  processCreditDebitNote: "/api/v1/sales/process-credit-debit-note",
  cancelReceipt: "/api/v1/sales/cancel-receipt",
  getVoidReceipts: "/api/v1/sales/get-void-receipts",
  productStatus: "/api/v1/utilities/product-status",
  ping: "/api/v1/utilities/ping",
  validateVat5: "/api/v1/utilities/validate-vat5-certificate",
  terminalBlockingMessage: "/api/v1/utilities/get-terminal-blocking-message",
  checkTerminalUnblockStatus: "/api/v1/utilities/check-terminal-unblock-status",
  checkTinAuthorizationRequirement: "/api/v1/utilities/check-tin-authorization-requirement",
  validateAuthorizationCode: "/api/v1/utilities/validate-authorization-code",
  terminalSiteProducts: "/api/v1/utilities/get-terminal-site-products",
  initialInventoryUpload: "/api/v1/utilities/taxpayer-initial-inventory-upload",
  submitInformalPurchase: "/api/v1/stock/submit-informal-purchase",
  transferInventory: "/api/v1/stock/transfer-inventory",
  warehouseInventory: "/api/v1/stock/warehouse-inventory",
  submitConversion: "/api/v1/raw-material/submit-conversion",
  getRawMaterial: "/api/v1/raw-material/get-raw-material",
  submitAdjustment: "/api/v1/stock/submit-adjustment",
  getStockAdjustmentReasons: "/api/v1/stock/getStockAdjustmentReasons",
  getSuppliers: "/api/v1/stock/get-suppliers",
  addProduct: "/api/v1/stock/add-product",
  getHsCodes: "/api/v1/stock/get-hs-codes",
  getUnitsOfMeasure: "/api/v1/stock/get-units-of-measure",
} as const;

export function summarizeErrors(result: MraCallResult): string {
  const details = result.errors
    .map((e) => [e.fieldName, e.errorMessage].filter(Boolean).join(": "))
    .filter(Boolean)
    .join("; ");
  return (
    [result.remark, details].filter(Boolean).join(" | ") ||
    result.error ||
    `MRA responded HTTP ${result.httpStatus}`
  );
}

export async function callMra<T = unknown>(options: {
  env: MraEnv;
  path: string;
  payload?: unknown;
  auth?: MraAuth;
  timeoutMs?: number;
  method?: "POST" | "GET";
}): Promise<MraCallResult<T>> {
  const { env, path, payload, auth } = options;
  const method = options.method ?? "POST";
  const body = method === "GET" ? null : (payload === null ? "" : JSON.stringify(payload ?? {}));
  const started = Date.now();

  const headers: Record<string, string> = {
    // The SDK uses application/json for all endpoints. MRA docs show text/plain
    // for most endpoints but application/json for get-latest-configs.
    // application/json works for all — confirmed by the official SDK.
    accept: "application/json",
    "content-type": "application/json",
  };
  if (auth?.accessKey) headers["x-access-key"] = auth.accessKey;
  if (auth?.xSignature) headers["x-signature"] = auth.xSignature;
  // MRA docs curl examples show raw JWT, but the official SDK and section 4.1.1.3
  // confirm Bearer prefix is required: "Bearer Authorization jwtToken".
  if (auth?.jwtToken) headers["authorization"] = `Bearer ${auth.jwtToken}`;
  // x-eis-message-hash: Base64 HMAC-SHA512 over the raw request body, required
  // on all requests except terminal activation (Developers Guide 4.1.1 + 9.2).
  if (
    auth?.secretKey &&
    method !== "GET" &&
    body &&
    !auth.xSignature &&
    path !== MRA_PATHS.activateTerminal
  ) {
    headers["x-eis-message-hash"] = await hmacSha512Base64(auth.secretKey, body);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? env.timeoutMs);

  try {
    const response = await fetch(`${env.baseUrl}${path}`, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    const raw = await response.text();

    let envelope: Record<string, unknown> | null = null;
    try {
      envelope = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    } catch {
      envelope = null;
    }

    const statusCode =
      envelope && typeof envelope["statusCode"] === "number"
        ? (envelope["statusCode"] as number)
        : null;

    return {
      ok: response.ok && statusCode === 1,
      httpStatus: response.status,
      statusCode,
      remark: (envelope?.["remark"] as string) ?? null,
      data: (envelope?.["data"] as T) ?? null,
      errors: Array.isArray(envelope?.["errors"])
        ? (envelope["errors"] as MraApiError[])
        : [],
      raw,
      durationMs: Date.now() - started,
      timedOut: false,
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      httpStatus: 0,
      statusCode: null,
      remark: null,
      data: null,
      errors: [],
      raw: "",
      durationMs: Date.now() - started,
      timedOut: aborted,
      error: aborted ? "MRA gateway timeout" : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}
