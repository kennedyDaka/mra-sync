/**
 * Sage (Pastel / Evolution) connector (inbound adapter).
 * Normalizes native Sage inventory CSV exports pushed via webhook.
 * Mappings ported from the OIH reference adapter (internal/adapters/sage.go).
 */
import type { ErpConnector, ConnectorConfig, Product, SubmitInvoicePayload } from "./base";
import { csvToInventory } from "./normalizers";

export class SageConnector implements ErpConnector {
  type = "sage";
  label = "Sage (Pastel / Evolution)";
  auth_type = "custom" as const;
  config_schema = {
    type: "object",
    properties: {
      default_terminal_id: {
        type: "string",
        title: "Default Terminal ID",
        description: "Optional: terminal used when the push does not send X-Terminal-ID",
      },
    },
    required: [],
  };

  async validateCredentials(_config: ConnectorConfig): Promise<boolean> {
    return true;
  }

  async listProducts(_config: ConnectorConfig): Promise<Product[]> {
    return [];
  }

  async ingestSale(_config: ConnectorConfig, _raw: unknown): Promise<SubmitInvoicePayload> {
    throw new Error("sage: sale ingestion via CSV is not supported; use the normalized ingest endpoint");
  }

  async ingestInventory(_config: ConnectorConfig, raw: unknown): Promise<Product[]> {
    if (typeof raw !== "string") {
      throw new Error("sage: invalid inventory payload: expected CSV text");
    }
    return csvToInventory(raw);
  }
}