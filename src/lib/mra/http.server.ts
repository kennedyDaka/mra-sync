/** Shared request helpers: JSON responses, tenant/terminal resolution, rate limiting. */
import type { SupabaseClient } from "@supabase/supabase-js";
import { sha256Hex } from "./crypto.server";

export function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function errorResponse(status: number, code: string, message: string, extra?: unknown) {
  return json({ error: code, message, details: extra ?? null }, status);
}

export interface TenantContext {
  tenantId: string;
  tenantName: string;
  mode: string;
  rateLimitPerMin: number;
  tokenId: string;
}

/** Logs an admin action to the audit_logs table. */
export async function auditLog(
  db: SupabaseClient,
  entry: {
    tenantId?: string;
    actorId?: string;
    actorEmail?: string;
    action: string;
    resourceType: string;
    resourceId?: string;
    ipAddress?: string;
    userAgent?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await db.from("audit_logs").insert({
    tenant_id: entry.tenantId ?? null,
    actor_id: entry.actorId ?? null,
    actor_email: entry.actorEmail ?? null,
    action: entry.action,
    resource_type: entry.resourceType,
    resource_id: entry.resourceId ?? null,
    ip_address: entry.ipAddress ?? null,
    user_agent: entry.userAgent ?? null,
    metadata: entry.metadata ?? null,
  });
}

/** Authenticates an ERP caller via its bearer token and returns the tenant. */
export async function authenticateTenant(
  db: SupabaseClient,
  request: Request,
): Promise<{ ok: true; context: TenantContext } | { ok: false; response: Response }> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";

  if (!token) {
    return {
      ok: false,
      response: errorResponse(401, "unauthorized", "Missing Authorization bearer token"),
    };
  }

  const hash = await sha256Hex(token);
  const { data, error } = await db
    .from("api_tokens")
    .select("id, tenant_id, revoked, expires_at, tenants(id, name, mode, rate_limit_per_min)")
    .eq("token_hash", hash)
    .maybeSingle();

  if (error || !data || data.revoked) {
    return {
      ok: false,
      response: errorResponse(401, "unauthorized", "Invalid or revoked API token"),
    };
  }

  // Check token expiry
  if (data.expires_at && new Date(data.expires_at) < new Date()) {
    return {
      ok: false,
      response: errorResponse(401, "token_expired", "API token has expired. Request a new token."),
    };
  }

  const tenant = data.tenants as unknown as {
    id: string;
    name: string;
    mode: string;
    rate_limit_per_min: number;
  };

  void db
    .from("api_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id)
    .then(() => undefined);

  return {
    ok: true,
    context: {
      tenantId: tenant.id,
      tenantName: tenant.name,
      mode: tenant.mode,
      rateLimitPerMin: tenant.rate_limit_per_min,
      tokenId: data.id,
    },
  };
}

/** Distributed token-bucket limiter, one bucket per tenant. */
export async function checkRateLimit(
  db: SupabaseClient,
  tenantId: string,
  perMinute: number,
): Promise<boolean> {
  const { data, error } = await db.rpc("consume_rate_token", {
    _tenant_id: tenantId,
    _capacity: perMinute,
    _refill_per_sec: perMinute / 60,
  });
  if (error) return true; // fail open rather than block checkouts
  return data === true;
}
