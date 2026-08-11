/**
 * Odoo ERP connector.
 * Connects to Odoo via XML-RPC (jsonrpc) to list products, submit invoices,
 * and sync inventory.
 *
 * Required config fields:
 *  - url: Odoo instance URL (e.g., https://mycompany.odoo.com)
 *  - database: Odoo database name
 *  - username: Odoo username (email)
 *  - password: Odoo password or API key
 */
import type {
  ErpConnector,
  ConnectorConfig,
  Product,
  SubmitInvoicePayload,
  SubmitResult,
  StockLevel,
} from "./base";

interface XmlRpcResponse {
  result?: unknown;
  fault?: { faultCode: number; faultString: string };
}

export class OdooConnector implements ErpConnector {
  type = "odoo";
  label = "Odoo ERP";
  auth_type = "basic" as const;
  config_schema = {
    type: "object",
    properties: {
      url: { type: "string", title: "Odoo URL", description: "https://yourcompany.odoo.com" },
      database: { type: "string", title: "Database", description: "Odoo database name" },
      username: { type: "string", title: "Username", description: "Email or username" },
      password: { type: "string", title: "Password / API Key", description: "Password or API key" },
    },
    required: ["url", "database", "username", "password"],
  };

  private async xmlRpc(config: ConnectorConfig, model: string, method: string, args: unknown[]): Promise<unknown> {
    const url = String(config["url"] ?? "").replace(/\/+$/, "");
    const db = String(config["database"] ?? "");
    const username = String(config["username"] ?? "");
    const password = String(config["password"] ?? "");

    // Step 1: Authenticate
    const authResponse = await fetch(`${url}/jsonrpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "call",
        params: {
          service: "common",
          method: "authenticate",
          args: [db, username, password, {}],
        },
      }),
    });
    const authResult = (await authResponse.json()) as XmlRpcResponse;
    const uid = authResult.result as number | false;
    if (!uid || typeof uid !== "number") {
      throw new Error("Odoo authentication failed");
    }

    // Step 2: Call the method
    const response = await fetch(`${url}/jsonrpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "call",
        params: {
          service: "object",
          method: "execute_kw",
          args: [db, uid, password, model, method, args],
        },
      }),
    });
    const result = (await response.json()) as XmlRpcResponse;
    if (result.fault) {
      throw new Error(`Odoo error: ${result.fault.faultString}`);
    }
    return result.result;
  }

  async validateCredentials(config: ConnectorConfig): Promise<boolean> {
    try {
      const url = String(config["url"] ?? "").replace(/\/+$/, "");
      const db = String(config["database"] ?? "");
      const username = String(config["username"] ?? "");
      const password = String(config["password"] ?? "");

      const response = await fetch(`${url}/jsonrpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "call",
          params: {
            service: "common",
            method: "authenticate",
            args: [db, username, password, {}],
          },
        }),
      });
      const result = (await response.json()) as XmlRpcResponse;
      return typeof result.result === "number" && result.result > 0;
    } catch {
      return false;
    }
  }

  async listProducts(config: ConnectorConfig): Promise<Product[]> {
    const products = (await this.xmlRpc(config, "product.template", "search_read", [
      [[["sale_ok", "=", true]]],
      { fields: ["default_code", "name", "list_price", "qty_available", "type"], limit: 1000 },
    ])) as Array<{
      default_code?: string;
      name?: string;
      list_price?: number;
      qty_available?: number;
      type?: string;
    }>;

    return products.map((p) => ({
      local_sku: p.default_code ?? "",
      description: p.name ?? "",
      unit_price: Number(p.list_price ?? 0),
      quantity_on_hand: Number(p.qty_available ?? 0),
      product_type: p.type === "service" ? "service" : "product",
    }));
  }

  async submitInvoice(config: ConnectorConfig, invoice: SubmitInvoicePayload): Promise<SubmitResult> {
    try {
      // Create account.move (invoice) in Odoo
      const moveId = await this.xmlRpc(config, "account.move", "create", [
        {
          move_type: "out_invoice",
          invoice_origin: invoice.erp_invoice_number,
          invoice_line_ids: invoice.line_items.map((item) => [
            0,
            0,
            {
              name: item.description ?? item.erp_sku,
              quantity: item.quantity,
              price_unit: item.unit_price,
              discount: item.discount ?? 0,
            },
          ]),
        },
      ]);

      return {
        ok: true,
        mra_status: "synced",
        receipt_code: String(moveId),
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown Odoo error",
      };
    }
  }

  async getStockLevels(config: ConnectorConfig): Promise<StockLevel[]> {
    const products = (await this.xmlRpc(config, "product.product", "search_read", [
      [[]],
      { fields: ["default_code", "qty_available", "write_date"], limit: 1000 },
    ])) as Array<{
      default_code?: string;
      qty_available?: number;
      write_date?: string;
    }>;

    return products
      .filter((p) => p.default_code)
      .map((p) => ({
        local_sku: p.default_code ?? "",
        quantity: Number(p.qty_available ?? 0),
        last_updated: p.write_date ?? new Date().toISOString(),
      }));
  }

  async syncInventory(config: ConnectorConfig): Promise<Product[]> {
    return this.listProducts(config);
  }
}
