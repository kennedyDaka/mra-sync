/**
 * Async invoice status notifications.
 *
 * When an invoice transitions to a terminal state (SUBMITTED / REJECTED /
 * FAILED) or is queued for offline sync (QUEUED), the middleware POSTs an
 * `invoice.status_changed` event to the tenant's configured callback.
 *
 * Callback resolution: the tenant's active `generic-webhook` connector
 * config (`callback_url` + `webhook_secret`). If none is configured the
 * notification is skipped silently — submission is never blocked by this.
 *
 * Delivery is best-effort with 3 attempts (0s / 2s / 8s backoff). Final
 * failures are logged to the audit trail.
 */
import { createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { openSecret } from "./crypto.server";
import { readEnv } from "./env.server";

export interface InvoiceStatusEvent {
  event: "invoice.status_changed";
  data: {
    id: string;
    erp_invoice_number: string;
    status: "SUBMITTED" | "REJECTED" | "FAILED" | "QUEUED";
    mra_invoice_id?: string | null;
    grand_total?: number;
    terminal_id?: string;
    last_error?: string | null;
    occurred_at: string;
  };
}

interface WebhookTarget {
  callbackUrl: string;
  secret: string;
}

async function resolveWebhookTarget(
  db: SupabaseClient,
  tenantId: string,
): Promise<WebhookTarget | null> {
  const { data: connector } = await db
    .from("tenant_connectors")
    .select("config_encrypted")
    .eq("tenant_id", tenantId)
    .eq("connector_type", "generic-webhook")
    .eq("is_active", true)
    .maybeSingle();
  if (!connector?.config_encrypted) return null;

  try {
    const env = readEnv();
    const config = JSON.parse(
      await openSecret(String(connector.config_encrypted), env.masterKey),
    ) as Record<string, string>;
    const callbackUrl = config["callback_url"]?.trim();
    if (!callbackUrl) return null;
    return { callbackUrl, secret: config["webhook_secret"] ?? "" };
  } catch {
    return null;
  }
}

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

async function deliver(target: WebhookTarget, body: string): Promise<boolean> {
  const delays = [0, 2_000, 8_000];
  for (const delay of delays) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try {
      const res = await fetch(target.callbackUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-event": "invoice.status_changed",
          "x-webhook-signature": sign(target.secret, body),
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return true;
    } catch {
      // fall through to next retry
    }
  }
  return false;
}

/**
 * Fire-and-forget status notification. Never throws — failures are audited.
 */
export async function notifyInvoiceStatus(
  db: SupabaseClient,
  tenantId: string,
  event: InvoiceStatusEvent,
): Promise<void> {
  try {
    const target = await resolveWebhookTarget(db, tenantId);
    if (!target) return;

    const body = JSON.stringify({ event: event.event, data: event.data });
    const delivered = await deliver(target, body);
    if (delivered) return;

    const { auditLog } = await import("./http.server");
    await auditLog(db as never, {
      tenantId,
      action: "webhook.delivery_failed",
      resourceType: "invoice",
      resourceId: event.data.id,
      metadata: { event: event.event, callback_url: target.callbackUrl },
    });
  } catch (err) {
    console.error(`[status-webhook] ${event.data.erp_invoice_number}:`, err instanceof Error ? err.message : err);
  }
}
