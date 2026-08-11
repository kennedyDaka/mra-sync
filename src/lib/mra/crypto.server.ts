/**
 * Cryptography engine — strictly per the MRA EIS Developers Guide.
 *
 *  - x-signature: Base64( HMAC-SHA512( TerminalActivationCode, secretKey ) )
 *    (used only when confirming terminal activation — section 4.1.1.2)
 *  - offlineSignature: Base64Url( HMAC-SHA256( param string, secretKey ) )
 *    (section 6.2 Signing Offline Receipts)
 *  - AES-256-GCM at-rest encryption of terminal credentials
 *  - SHA-256 hashing of ERP bearer tokens
 *
 * Uses Web Crypto so it runs in the edge server runtime.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const bin = atob(value);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Canonical serialization: zero whitespace, tabs, padding or newlines. */
export function canonicalJson(payload: unknown): string {
  return JSON.stringify(payload);
}

async function hmac(
  secretKey: string,
  message: string,
  hash: "SHA-512" | "SHA-256",
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secretKey),
    { name: "HMAC", hash },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

/** Base64 HMAC-SHA512 — the x-signature scheme (section 5.1.2.1). */
export async function hmacSha512Base64(secretKey: string, message: string): Promise<string> {
  return toBase64(await hmac(secretKey, message, "SHA-512"));
}

/** Base64Url (no padding) HMAC-SHA256 — the offlineSignature scheme (section 6.2). */
export async function hmacSha256Base64Url(secretKey: string, message: string): Promise<string> {
  return toBase64(await hmac(secretKey, message, "SHA-256"))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(value)));
}

/** Julian Day Number for a transaction date (section 5.3.1.1.1). */
export function toJulianDate(date: Date): number {
  let year = date.getUTCFullYear();
  let month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  if (month <= 2) {
    year -= 1;
    month += 12;
  }
  const a = Math.floor(year / 100);
  const b = 2 - a + Math.floor(a / 4);
  return (
    Math.floor(365.25 * (year + 4716)) + Math.floor(30.6001 * (month + 1)) + day + b - 1524
  );
}

const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base10 -> Base64 digit encoding used by the invoice number generator. */
export function base10ToBase64(value: number): string {
  let n = Math.floor(Math.abs(value));
  if (n === 0) return "A";
  let out = "";
  while (n > 0) {
    out = BASE64_CHARS[n % 64] + out;
    n = Math.floor(n / 64);
  }
  return out;
}

async function deriveAesKey(masterKey: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest("SHA-256", enc.encode(masterKey));
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

const PLAINTEXT_PREFIX = "plain:";
const CIPHER_PREFIX = "gcm:";

/**
 * Encrypts a credential. In development mode the value is stored readable
 * (prefixed) for UAT debugging; in production it is always AES-256-GCM sealed.
 */
export async function sealSecret(
  value: string,
  masterKey: string,
  isProduction: boolean,
): Promise<string> {
  if (!isProduction && !masterKey) return `${PLAINTEXT_PREFIX}${value}`;
  if (!masterKey) throw new Error("MRA_MASTER_KEY is not configured");

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(masterKey);
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(value));
  return `${CIPHER_PREFIX}${toBase64(iv)}.${toBase64(new Uint8Array(cipher))}`;
}

export async function openSecret(stored: string, masterKey: string): Promise<string> {
  if (stored.startsWith(PLAINTEXT_PREFIX)) return stored.slice(PLAINTEXT_PREFIX.length);
  if (!stored.startsWith(CIPHER_PREFIX)) return stored;

  const [ivPart, dataPart] = stored.slice(CIPHER_PREFIX.length).split(".");
  if (!ivPart || !dataPart) throw new Error("Malformed encrypted credential");

  const key = await deriveAesKey(masterKey);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(ivPart) },
    key,
    fromBase64(dataPart),
  );
  return dec.decode(plain);
}

/** Generates an ERP-facing bearer token: returns the raw token and its hash. */
export async function mintApiToken(): Promise<{
  token: string;
  hash: string;
  prefix: string;
}> {
  const raw = toHex(crypto.getRandomValues(new Uint8Array(24)).buffer);
  const token = `mra_${raw}`;
  return { token, hash: await sha256Hex(token), prefix: token.slice(0, 12) };
}

/**
 * MRA EIS validates timestamps against Malawi local time (CAT, UTC+2) and
 * rejects submissions with "Client time differs from server time by 2 hours"
 * when a UTC instant is sent. All fiscal timestamps and Julian dates must be
 * expressed in CAT.
 */
export const MALAWI_UTC_OFFSET_MINUTES = 120;

export function toMalawiTime(date: Date): Date {
  return new Date(date.getTime() + MALAWI_UTC_OFFSET_MINUTES * 60_000);
}

/** `YYYY-MM-DDTHH:mm:ss` in Malawi local time — the format MRA expects. */
export function formatMraDateTime(date: Date): string {
  return toMalawiTime(date).toISOString().replace(/\.\d+Z$/, "");
}

/** Julian Day Number computed on the Malawi local calendar date. */
export function toMalawiJulianDate(date: Date): number {
  return toJulianDate(toMalawiTime(date));
}
