/**
 * Generic Webhook connector.
 * Push-based: the ERP/POS sends data to our webhook endpoint
 * (`POST /api/public/v1/ingest/sales` or `/api/public/v1/ingest/inventory`).
 * Optional callback URL lets us push submitted invoices back to the ERP,
 * signed with HMAC-SHA256 using the shared webhook secret.
 */
import { createHmac } from "node:crypto";
import type {
  ErpConnector,
  ConnectorConfig,
  Product,
  SubmitInvoicePayload,
  SubmitResult,
  StockLevel,
} from "./base";

export class GenericWebhookConnector implements ErpConnector {
  type = "generic-webhook";
  label = "Custom Webhook (Push)";
  auth_type = "custom" as const;
  config_schema = {
    type: "object",
    properties: {
      webhook_secret: { type: "string", title: "Webhook Secret", description: "Shared secret: ERPs send it as X-Webhook-Secret when pushing to our ingest endpoint" },
      callback_url: { type: "string", title: "Callback URL (optional)", description: "Your ERP endpoint; the middleware POSTs submitted invoices here with an x-webhook-signature header" },
      default_terminal_id: {
        type: "string",
        title: "Default Terminal ID",
        description: "Optional: terminal used when the push does not send X-Terminal-ID",
      },
    },
    required: ["webhook_secret"],
  };

  async validateCredentials(config: ConnectorConfig): Promise<boolean> {
    return Boolean(config["webhook_secret"]);
  }

  async listProducts(_config: ConnectorConfig): Promise<Product[]> {
    // Webhook connectors don't pull products — data is pushed to them.
    return [];
  }

  async getStockLevels(_config: ConnectorConfig): Promise<StockLevel[]> {
    return [];
  }

  /** Push a submitted invoice back to the ERP's callback URL, signed. */
  async submitInvoice(config: ConnectorConfig, invoice: SubmitInvoicePayload): Promise<SubmitResult> {
    const callbackUrl = String(config["callback_url"] ?? "").trim();
    if (!callbackUrl) {
      return { ok: false, error: "generic-webhook: callback_url not configured" };
    }

    const body = JSON.stringify(invoice);
    const secret = String(config["webhook_secret"] ?? "");
    const signature = secret ? createHmac("sha256", secret).update(body).digest("hex") : "";

    try {
      const response = await fetch(callbackUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(signature ? { "x-webhook-signature": signature } : {}),
        },
        body,
      });
      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status}: ${await response.text()}` };
      }
      return { ok: true, mra_status: "synced" };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "generic-webhook: callback failed",
      };
    }
  }
}

/** Verify an HMAC-SHA256 hex signature over a body against the shared secret. */
export function verifyWebhookSignature(secret: string, body: string, signature: string): boolean {
  if (!secret || !signature) return false;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature, "hex");
  if (a.length !== b.length) return false;
  return a.equals(b);
}