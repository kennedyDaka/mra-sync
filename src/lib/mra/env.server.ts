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

export function readEnv(): MraEnv {
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

  // Production must have a real encryption key — never allow empty
  if (isProduction && !masterKey) {
    throw new Error(
      "MRA_MASTER_KEY is required in production mode. " +
        "Set it to a secure random string (min 32 chars) before deploying.",
    );
  }

  return {
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
}
