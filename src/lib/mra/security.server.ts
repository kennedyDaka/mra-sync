/** Security middleware: CORS, CSP headers, input validation. */
import { readEnv } from "./env.server";

const ALLOWED_ORIGINS_DEV = ["http://localhost:5173", "http://localhost:3000"];

const ALLOWED_ORIGINS_PROD = [
  "https://mraconnect.app",
  "https://www.mraconnect.app",
  "https://api.mraconnect.app",
  "https://mra-sync-nexus-main.vercel.app",
];

/** Returns the allowed CORS origin for the current request. */
function getAllowedOrigin(): string {
  const env = readEnv();
  const origins = env.isProduction ? ALLOWED_ORIGINS_PROD : ALLOWED_ORIGINS_DEV;
  return origins[0] ?? "";
}

/** Clones a Response and sets a header on the clone. */
function cloneWithHeader(response: Response, key: string, value: string): Response {
  const headers = new Headers(response.headers);
  headers.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Adds security headers to a Response. */
export function withSecurityHeaders(response: Response): Response {
  let r = response;
  r = cloneWithHeader(r, "X-Content-Type-Options", "nosniff");
  r = cloneWithHeader(r, "X-Frame-Options", "DENY");
  r = cloneWithHeader(r, "X-XSS-Protection", "1; mode=block");
  r = cloneWithHeader(r, "Referrer-Policy", "strict-origin-when-cross-origin");
  r = cloneWithHeader(r, "Permissions-Policy", "camera=(), microphone=(), geolocation=()");

  const env = readEnv();
  if (env.isProduction) {
    r = cloneWithHeader(r, "Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  }

  return r;
}

/** Handles CORS preflight and adds CORS headers to responses. */
export function handleCors(request: Request, response: Response): Response {
  const origin = request.headers.get("origin") ?? "";
  const allowedOrigin = getAllowedOrigin();
  const env = readEnv();

  const isAllowed = env.isProduction
    ? ALLOWED_ORIGINS_PROD.includes(origin)
    : ALLOWED_ORIGINS_DEV.includes(origin) || origin === "";

  let r = response;

  if (isAllowed && origin) {
    r = cloneWithHeader(r, "Access-Control-Allow-Origin", origin);
  } else if (!origin) {
    r = cloneWithHeader(r, "Access-Control-Allow-Origin", allowedOrigin);
  }

  r = cloneWithHeader(r, "Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  r = cloneWithHeader(r, "Access-Control-Allow-Headers", "Content-Type, Authorization, X-Request-ID");
  r = cloneWithHeader(r, "Access-Control-Max-Age", "86400");

  return r;
}

/** Handles CORS preflight OPTIONS request. Returns Response or null (not a preflight). */
export function handlePreflight(request: Request): Response | null {
  if (request.method !== "OPTIONS") return null;

  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Request-ID",
      "Access-Control-Max-Age": "86400",
    },
  });
}

/** Wraps a route handler with CORS + security headers. */
export async function withSecurity(
  request: Request,
  handler: () => Promise<Response> | Response,
): Promise<Response> {
  const preflight = handlePreflight(request);
  if (preflight) return preflight;

  const response = await handler();
  const secured = withSecurityHeaders(response);
  return handleCors(request, secured);
}
