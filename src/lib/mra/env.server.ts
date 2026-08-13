/** Environment configuration. Must only be read inside server handlers. */

export type AppMode = "development" | "production";

export interface MraEnv {
  mode: AppMode;
  /** MRA EIS API base URL, e.g. https://dev-eis-api.mra.mw */
  baseUrl: string;
  /** Receipt validation portal base URL used for offline QR codes. */
  validationBaseUrl: string;
  timeoutMs: number;
  masterKey: string;
  /** Vendor Access Key issued by MRA on certification (production activation only). */
  vendorAccessKey: string;
  /** Certified POS product identity sent in the activation environment block. */
  posProductId: string;
  posProductVersion: string;
  isProduction: boolean;
}

let _validated = false;
let _cached: MraEnv | null = null;

export function readEnv(): MraEnv {
  if (_validated && _cached) return _cached;

  const mode = (process.env["APP_MODE"] ?? "development") as AppMode;
  const isProduction = mode === "production";

  const baseUrl = (
    process.env["MRA_BASE_URL"] ??
    (isProduction ? "https://eis-api.mra.mw" : "https://dev-eis-api.mra.mw")
  ).replace(/\/+$/, "");

  const validationBaseUrl = (
    process.env["MRA_VALIDATION_BASE_URL"] ??
    (isProduction
      ? "https://eis-portal.mra.mw/ReceiptValidation/Validate/"
      : "https://dev-eis-portal.mra.mw/ReceiptValidation/Validate/")
  ).replace(/\?+$/, "");

  const timeoutMs = Number(process.env["MRA_TIMEOUT_MS"] ?? "1500");
  const masterKey = process.env["MRA_MASTER_KEY"] ?? "";
  const cronSecret = process.env["CRON_SECRET"] ?? "";

  // ---- CRITICAL: Fail fast on invalid configuration ----

  // MRA_MASTER_KEY is required in ALL modes — credentials are encrypted with it.
  // Without it, terminal activation succeeds but sales fail with GCM decryption errors.
  if (!masterKey || masterKey.length < 32) {
    throw new Error(
      `[ENV] MRA_MASTER_KEY is required (min 32 chars). ` +
        `Current length: ${masterKey.length}. ` +
        `Set it in .env and Vercel dashboard before deploying.`,
    );
  }

  // Production-specific checks
  if (isProduction) {
    const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_JWT_SECRET"] as const;
    for (const key of required) {
      if (!process.env[key]) {
        throw new Error(`[ENV] Missing required production env var: ${key}`);
      }
    }
    if (!cronSecret) {
      throw new Error("[ENV] CRON_SECRET is required in production for hook protection");
    }
  }

  // Warn about missing optional vars (non-fatal)
  if (!cronSecret && !isProduction) {
    console.warn("[ENV] CRON_SECRET not set — sync hooks are unprotected in development");
  }

  _validated = true;
  _cached = {
    mode,
    baseUrl,
    validationBaseUrl,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 1500,
    masterKey,
    vendorAccessKey: process.env["MRA_VENDOR_ACCESS_KEY"] ?? "",
    posProductId: process.env["MRA_POS_PRODUCT_ID"] ?? "MRA-middleware/mraconnect",
    posProductVersion: process.env["MRA_POS_PRODUCT_VERSION"] ?? "1.0.0",
    isProduction,
  };
  return _cached;
}
