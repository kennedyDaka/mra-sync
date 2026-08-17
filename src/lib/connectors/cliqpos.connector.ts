/**
 * CliqPOS connector (inbound adapter).
 * Normalizes native CliqPOS sale/inventory payloads pushed via webhook.
 * Mappings ported from the OIH reference adapter (internal/adapters/cliqpos.go).
 */
import type { ErpConnector, ConnectorConfig, Product, SubmitInvoicePayload } from "./base";
import { mapPaymentMethod, num, str } from "./normalizers";

interface CliqItem {
  sku?: unknown;
  name?: unknown;
  barcode?: unknown;
  qty?: unknown;
  unitPrice?: unknown;
  taxRate?: unknown;
  discount?: unknown;
}

interface CliqSale {
  receiptNo?: unknown;
  customer?: unknown;
  customerTin?: unknown;
  phone?: unknown;
  payment?: unknown;
  momoReference?: unknown;
  items?: CliqItem[];
}

interface CliqProduct {
  sku?: unknown;
  name?: unknown;
  barcode?: unknown;
  category?: unknown;
  stock?: unknown;
  price?: unknown;
  cost?: unknown;
  taxRate?: unknown;
  isService?: unknown;
}

export class CliqPosConnector implements ErpConnector {
  type = "cliqpos";
  label = "CliqPOS";
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
    const sale = (raw ?? {}) as CliqSale;
    if (!Array.isArray(sale.items)) {
      throw new Error("cliqpos: invalid sale payload: missing items array");
    }
    if (!str(sale.receiptNo)) {
      throw new Error("cliqpos: receiptNo is required");
    }

    return {
      erp_invoice_number: str(sale.receiptNo),
      buyer_name: str(sale.customer),
      customer_tin: str(sale.customerTin),
      payment_method: mapPaymentMethod(str(sale.payment)),
      line_items: sale.items.map((item) => {
        const line: SubmitInvoicePayload["line_items"][number] = {
          erp_sku: str(item.sku) || str(item.barcode) || str(item.name),
          description: str(item.name),
          quantity: num(item.qty),
          unit_price: num(item.unitPrice),
        };
        const discount = num(item.discount);
        if (discount) line.discount = discount;
        const taxRate = str(item.taxRate);
        if (taxRate) line.tax_rate_id = taxRate;
        return line;
      }),
    };
  }

  async ingestInventory(_config: ConnectorConfig, raw: unknown): Promise<Product[]> {
    const inv = (raw ?? {}) as { products?: CliqProduct[] };
    if (!Array.isArray(inv.products)) {
      throw new Error("cliqpos: invalid inventory payload: missing products array");
    }

    return inv.products.map((p) => {
      const product: Product = {
        local_sku: str(p.sku) || str(p.barcode),
        description: str(p.name),
        unit_price: num(p.price),
        quantity_on_hand: num(p.stock),
        product_type: p.isService ? "service" : "product",
      };
      const taxRate = str(p.taxRate);
      if (taxRate) product.tax_rate_id = taxRate;
      return product;
    });
  }
}