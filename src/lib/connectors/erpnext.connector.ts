/**
 * ERPNext connector (inbound adapter).
 * Normalizes native ERPNext invoice/inventory payloads pushed via webhook.
 * Mappings ported from the OIH reference adapter (internal/adapters/erpnext.go).
 */
import type { ErpConnector, ConnectorConfig, Product, SubmitInvoicePayload } from "./base";
import { num, str } from "./normalizers";

interface ErpNextLine {
  item_code?: unknown;
  item_name?: unknown;
  qty?: unknown;
  rate?: unknown;
  amount?: unknown;
  uom?: unknown;
  warehouse?: unknown;
}

interface ErpNextInvoice {
  name?: unknown;
  customer?: unknown;
  customer_tin?: unknown;
  posting_date?: unknown;
  grand_total?: unknown;
  items?: ErpNextLine[];
}

interface ErpNextProduct {
  item_code?: unknown;
  item_name?: unknown;
  item_group?: unknown;
  barcode?: unknown;
  actual_qty?: unknown;
  valuation_rate?: unknown;
  price_list_rate?: unknown;
  standard_rate?: unknown;
  stock_uom?: unknown;
  is_stock_item?: unknown;
}

export class ErpNextConnector implements ErpConnector {
  type = "erpnext";
  label = "ERPNext";
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

  async ingestSale(_config: ConnectorConfig, raw: unknown): Promise<SubmitInvoicePayload> {
    const inv = (raw ?? {}) as ErpNextInvoice;
    if (!Array.isArray(inv.items)) {
      throw new Error("erpnext: invalid sale payload: missing items array");
    }
    if (!str(inv.name)) {
      throw new Error("erpnext: name is required");
    }

    return {
      erp_invoice_number: str(inv.name),
      buyer_name: str(inv.customer),
      customer_tin: str(inv.customer_tin),
      payment_method: "BankTransfer",
      line_items: inv.items.map((line) => ({
        erp_sku: str(line.item_code),
        description: str(line.item_name),
        quantity: num(line.qty),
        unit_price: num(line.rate),
      })),
    };
  }

  async ingestInventory(_config: ConnectorConfig, raw: unknown): Promise<Product[]> {
    const inv = (raw ?? {}) as { items?: ErpNextProduct[] };
    if (!Array.isArray(inv.items)) {
      throw new Error("erpnext: invalid inventory payload: missing items array");
    }

    return inv.items.map((p) => {
      const standard = num(p.standard_rate);
      const list = num(p.price_list_rate);
      const price = standard > 0 ? standard : list;
      return {
        local_sku: str(p.item_code),
        description: str(p.item_name),
        unit_price: price,
        quantity_on_hand: num(p.actual_qty),
        product_type: num(p.is_stock_item) === 0 ? "service" : "product",
      };
    });
  }
}