/**
 * Generic Webhook connector.
 * Push-based: the ERP/POS sends data to our webhook endpoint.
 * We store the payload and process it asynchronously.
 */
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
      webhook_secret: { type: "string", title: "Webhook Secret", description: "HMAC-SHA256 secret for verifying incoming webhooks" },
      webhook_url: { type: "string", title: "Webhook URL (read-only)", description: "URL for your ERP/POS to push data to" },
    },
    required: ["webhook_secret"],
  };

  async validateCredentials(_config: ConnectorConfig): Promise<boolean> {
    // Webhooks don't need validation — they push to us
    return true;
  }

  async listProducts(_config: ConnectorConfig): Promise<Product[]> {
    // Webhook connectors don't pull products — data is pushed to them
    return [];
  }

  async getStockLevels(_config: ConnectorConfig): Promise<StockLevel[]> {
    return [];
  }
}
