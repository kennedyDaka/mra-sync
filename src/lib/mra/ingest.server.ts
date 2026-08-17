/**
 * Ingest handlers for native ERP/POS payloads.
 *
 * Two shapes are accepted:
 *   - Normalized: POST /api/public/v1/ingest/sales (body = middleware sales schema)
 *   - Native:     POST /api/public/v1/ingest/$source/sales (body = ERP/POS native JSON;
 *                 sage inventory may also be CSV text)
 *
 * Authentication: Bearer <api_token> (tenant API token) OR, for webhook-style
 * callers, X-Tenant-ID + (X-Webhook-Secret | X-Webhook-Signature) validated
 * against the tenant's generic-webhook connector config.
 *
 * Terminal resolution order:
 *   1. X-Terminal-ID header
 *   2. The source connector config's `default_terminal_id`
 *   3. The tenant's first active terminal
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { readEnv } from "./env.server";
import { openSecret } from "./crypto.server";
import { authenticateTenant, errorResponse } from "./http.server";
import { handleInventorySync, handleSales } from "./handlers.server";
import { verifyWebhookSignature } from "@/lib/connectors/generic-webhook.connector";
import { getConnector } from "@/lib/connectors/registry";
import type { ConnectorConfig, Product } from "@/lib/connectors/base";

async function getDb(): Promise<SupabaseClient> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as unknown as SupabaseClient;
}

export const SUPPORTED_SOURCES = [
  "aronium",
  "cliqpos",
  "erpnext",
  "kiboerp",
  "odoo",
  "sage",
  "sap-b1",
  "tally",
] as const;

export type IngestSource = (typeof SUPPORTED_SOURCES)[number];

export interface IngestAuthContext {
  tenantId: string;
  rateLimitPerMin: number;
}

interface ParsedRequest {
  rawText: string;
  parsed: unknown;
}

function parseBody(rawText: string): { ok: true; parsed: unknown } | { ok: false } {
  try {
    return { ok: true, parsed: JSON.parse(rawText) };
  } catch {
    return { ok: false };
  }
}

async function loadConnectorConfig(
  tenantId: string,
  connectorType: string,
): Promise<ConnectorConfig | null> {
  const db = await getDb();
  const env = readEnv();
  const { data } = await db
    .from("tenant_connectors")
    .select("config_encrypted")
    .eq("tenant_id", tenantId)
    .eq("connector_type", connectorType)
    .eq("is_active", true)
    .maybeSingle();

  if (!data || !data["config_encrypted"]) return null;
  const configStr = await openSecret(data["config_encrypted"] as string, env.masterKey).catch(
    () => null,
  );
  if (!configStr) return null;
  try {
    return JSON.parse(configStr) as ConnectorConfig;
  } catch {
    return null;
  }
}

async function authenticateWebhook(
  request: Request,
  rawBody: string,
): Promise<IngestAuthContext | null> {
  const tenantId = request.headers.get("x-tenant-id");
  const secret = request.headers.get("x-webhook-secret");
  const signature = request.headers.get("x-webhook-signature");
  if (!tenantId || (!secret && !signature)) return null;

  const config = await loadConnectorConfig(tenantId, "generic-webhook");
  if (!config) return null;

  const expected = String(config["webhook_secret"] ?? "");
  if (!expected) return null;

  const matches = secret
    ? secret === expected
    : verifyWebhookSignature(expected, rawBody, signature ?? "");
  if (!matches) return null;

  const db = await getDb();
  const { data: tenant } = await db
    .from("tenants")
    .select("rate_limit_per_min")
    .eq("id", tenantId)
    .maybeSingle();
  if (!tenant) return null;

  return { tenantId, rateLimitPerMin: Number(tenant["rate_limit_per_min"] ?? 60) };
}

async function authenticateIngest(
  request: Request,
  rawBody: string,
): Promise<IngestAuthContext | Response> {
  const header = request.headers.get("authorization") ?? "";
  if (header.toLowerCase().startsWith("bearer ")) {
    const db = await getDb();
    const auth = await authenticateTenant(db, request);
    if (!auth.ok) return auth.response;
    return { tenantId: auth.context.tenantId, rateLimitPerMin: auth.context.rateLimitPerMin };
  }
  const webhook = await authenticateWebhook(request, rawBody);
  if (webhook) return webhook;
  return errorResponse(
    401,
    "unauthorized",
    "Missing or invalid credentials: provide a Bearer <api_token> or X-Tenant-ID with a matching webhook secret",
  );
}

async function firstActiveTerminal(tenantId: string): Promise<string | null> {
  const db = await getDb();
  const { data } = await db
    .from("terminals")
    .select("terminal_id")
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .eq("is_blocked", false)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data?.["terminal_id"] as string | undefined) ?? null;
}

export async function handleIngestSale(
  request: Request,
  source: string | null,
): Promise<Response> {
  const rawText = await request.text();
  const auth = await authenticateIngest(request, rawText);
  if (auth instanceof Response) return auth;
  const ctx = auth;

  if (source && !(SUPPORTED_SOURCES as readonly string[]).includes(source)) {
    return errorResponse(400, "unknown_source", `Unsupported source '${source}'`);
  }

  let payloadBody = rawText;

  if (source) {
    const connector = getConnector(source);
    if (!connector) {
      return errorResponse(400, "unknown_source", `Unsupported source '${source}'`);
    }
    if (!connector.ingestSale) {
      return errorResponse(
        400,
        "source_not_ingestible",
        `Source '${source}' does not support sale ingestion (inventory CSV only)`,
      );
    }
    const parsed = parseBody(rawText);
    if (!parsed.ok) {
      return errorResponse(400, "invalid_json", "Request body is not valid JSON");
    }
    const config = await loadConnectorConfig(ctx.tenantId, source);
    try {
      const normalized = await connector.ingestSale(config ?? {}, parsed.parsed);
      payloadBody = JSON.stringify(normalized);
    } catch (e) {
      return errorResponse(
        400,
        "normalization_failed",
        `Failed to normalize ${source} sale payload: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  let terminalKey = request.headers.get("x-terminal-id");
  if (!terminalKey && source) {
    const config = await loadConnectorConfig(ctx.tenantId, source);
    terminalKey = String(config?.["default_terminal_id"] ?? "").trim() || null;
  }
  if (!terminalKey) {
    terminalKey = await firstActiveTerminal(ctx.tenantId);
  }
  if (!terminalKey) {
    return errorResponse(
      400,
      "missing_terminal",
      "No terminal found: send X-Terminal-ID, configure default_terminal_id on the connector, or activate a terminal",
    );
  }

  const bearer = request.headers.get("authorization") ?? "";
  const forwarded = new Request(request.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-terminal-id": terminalKey,
      ...(bearer.toLowerCase().startsWith("bearer ")
        ? { authorization: bearer }
        : {}),
    },
    body: payloadBody,
  });

  return handleSales(forwarded, ctx);
}

export async function handleIngestInventory(
  request: Request,
  source: string | null,
): Promise<Response> {
  const rawText = await request.text();
  const auth = await authenticateIngest(request, rawText);
  if (auth instanceof Response) return auth;
  const ctx = auth;

  if (source && !(SUPPORTED_SOURCES as readonly string[]).includes(source)) {
    return errorResponse(400, "unknown_source", `Unsupported source '${source}'`);
  }

  let payloadBody = rawText;

  if (source) {
    const connector = getConnector(source);
    if (!connector) {
      return errorResponse(400, "unknown_source", `Unsupported source '${source}'`);
    }
    if (!connector.ingestInventory) {
      return errorResponse(400, "source_not_ingestible", `Source '${source}' does not support inventory ingestion`);
    }
    const config = await loadConnectorConfig(ctx.tenantId, source);
    try {
      // Sage inventory arrives as CSV text; all other sources use JSON.
      const parsedBody = parseBody(rawText);
      const raw: unknown = source === "sage" ? rawText : parsedBody.ok ? parsedBody.parsed : undefined;
      if (raw === undefined) {
        return errorResponse(400, "invalid_json", "Request body is not valid JSON");
      }
      const products = await connector.ingestInventory(config ?? {}, raw);
      payloadBody = JSON.stringify({
        items: products.map(toInventoryRow),
      });
    } catch (e) {
      return errorResponse(
        400,
        "normalization_failed",
        `Failed to normalize ${source} inventory payload: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  const forwarded = new Request(request.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(request.headers.get("authorization") ? { authorization: request.headers.get("authorization")! } : {}),
    },
    body: payloadBody,
  });

  return handleInventorySync(forwarded, ctx);
}

function toInventoryRow(p: Product): Record<string, unknown> {
  const row: Record<string, unknown> = {
    local_sku: p.local_sku,
    description: p.description,
    product_type: p.product_type,
    informal_purchase: false,
  };
  if (p.tax_rate_id) row["tax_rate_id"] = p.tax_rate_id;
  if (p.product_type === "product") row["quantity_on_hand"] = p.quantity_on_hand;
  return row;
}