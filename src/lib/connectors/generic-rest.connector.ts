/**
 * Generic REST API connector.
 * Works with any ERP/POS that exposes a REST API.
 * The tenant configures the endpoint URLs and authentication.
 */
import type {
  ErpConnector,
  ConnectorConfig,
  Product,
  SubmitInvoicePayload,
  SubmitResult,
  StockLevel,
} from "./base";

export class GenericRestConnector implements ErpConnector {
  type = "generic-rest";
  label = "Generic REST API";
  auth_type = "api_key" as const;
  config_schema = {
    type: "object",
    properties: {
      base_url: { type: "string", title: "Base URL" },
      api_key: { type: "string", title: "API Key" },
      products_endpoint: { type: "string", title: "Products Endpoint", default: "/api/products" },
      invoices_endpoint: { type: "string", title: "Invoices Endpoint", default: "/api/invoices" },
      stock_endpoint: { type: "string", title: "Stock Endpoint", default: "/api/stock" },
    },
    required: ["base_url", "api_key"],
  };

  private headers(config: ConnectorConfig): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config["api_key"] ?? ""}`,
    };
  }

  async validateCredentials(config: ConnectorConfig): Promise<boolean> {
    try {
      const baseUrl = String(config["base_url"] ?? "").replace(/\/+$/, "");
      const response = await fetch(`${baseUrl}/api/health`, {
        headers: this.headers(config),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async listProducts(config: ConnectorConfig): Promise<Product[]> {
    const baseUrl = String(config["base_url"] ?? "").replace(/\/+$/, "");
    const endpoint = String(config["products_endpoint"] ?? "/api/products");
    const response = await fetch(`${baseUrl}${endpoint}`, { headers: this.headers(config) });
    if (!response.ok) throw new Error(`Failed to fetch products: ${response.status}`);
    const data = (await response.json()) as { items?: unknown[]; products?: unknown[] };
    const items = (data.items ?? data.products ?? []) as Array<Record<string, unknown>>;
    return items.map((p) => ({
      local_sku: String(p["local_sku"] ?? p["sku"] ?? p["code"] ?? ""),
      description: String(p["description"] ?? p["name"] ?? ""),
      unit_price: Number(p["unit_price"] ?? p["price"] ?? 0),
      quantity_on_hand: Number(p["quantity_on_hand"] ?? p["stock"] ?? 0),
      product_type: (p["product_type"] as "product" | "service") ?? "product",
    }));
  }

  async submitInvoice(config: ConnectorConfig, invoice: SubmitInvoicePayload): Promise<SubmitResult> {
    const baseUrl = String(config["base_url"] ?? "").replace(/\/+$/, "");
    const endpoint = String(config["invoices_endpoint"] ?? "/api/invoices");
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: "POST",
      headers: this.headers(config),
      body: JSON.stringify(invoice),
    });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}: ${await response.text()}` };
    }
    const result = (await response.json()) as { id?: string; receipt_code?: string };
    return {
      ok: true,
      mra_status: "synced",
      receipt_code: result.receipt_code ?? result.id ?? null,
    };
  }

  async getStockLevels(config: ConnectorConfig): Promise<StockLevel[]> {
    const baseUrl = String(config["base_url"] ?? "").replace(/\/+$/, "");
    const endpoint = String(config["stock_endpoint"] ?? "/api/stock");
    const response = await fetch(`${baseUrl}${endpoint}`, { headers: this.headers(config) });
    if (!response.ok) throw new Error(`Failed to fetch stock: ${response.status}`);
    const data = (await response.json()) as { items?: unknown[]; stock?: unknown[] };
    const items = (data.items ?? data.stock ?? []) as Array<Record<string, unknown>>;
    return items.map((s) => ({
      local_sku: String(s["local_sku"] ?? s["sku"] ?? s["code"] ?? ""),
      quantity: Number(s["quantity"] ?? s["qty"] ?? 0),
      last_updated: String(s["last_updated"] ?? new Date().toISOString()),
    }));
  }

  async syncInventory(config: ConnectorConfig): Promise<Product[]> {
    return this.listProducts(config);
  }
}
