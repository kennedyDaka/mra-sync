/**
 * KiboERP connector (inbound adapter).
 * Normalizes native KiboERP order/inventory payloads pushed via webhook.
 * Mappings ported from the OIH reference adapter (internal/adapters/kiboerp.go).
 */
import type { ErpConnector, ConnectorConfig, Product, SubmitInvoicePayload } from "./base";
import { mapPaymentMethod, num, str } from "./normalizers";

interface KiboLine {
  productCode?: unknown;
  productName?: unknown;
  quantity?: unknown;
  unitPrice?: unknown;
  taxRate?: unknown;
}

interface KiboOrder {
  id?: unknown;
  reference?: unknown;
  clientName?: unknown;
  clientTin?: unknown;
  clientPhone?: unknown;
  paymentMethod?: unknown;
  totalAmount?: unknown;
  lines?: KiboLine[];
}

interface KiboProduct {
  id?: unknown;
  code?: unknown;
  designation?: unknown;
  barcode?: unknown;
  category?: unknown;
  stockQuantity?: unknown;
  unitPrice?: unknown;
  costPrice?: unknown;
  taxRate?: unknown;
  isService?: unknown;
  unitOfMeasure?: unknown;
}

export class KiboErpConnector implements ErpConnector {
  type = "kiboerp";
  label = "KiboERP";
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
    const order = (raw ?? {}) as KiboOrder;
    if (!Array.isArray(order.lines)) {
      throw new Error("kiboerp: invalid sale payload: missing lines array");
    }
    if (!str(order.reference)) {
      throw new Error("kiboerp: reference is required");
    }

    return {
      erp_invoice_number: str(order.reference),
      buyer_name: str(order.clientName),
      customer_tin: str(order.clientTin),
      payment_method: mapPaymentMethod(str(order.paymentMethod)),
      line_items: order.lines.map((line) => {
        const item: SubmitInvoicePayload["line_items"][number] = {
          erp_sku: str(line.productCode),
          description: str(line.productName),
          quantity: num(line.quantity),
          unit_price: num(line.unitPrice),
        };
        const taxRate = str(line.taxRate);
        if (taxRate) item.tax_rate_id = taxRate;
        return item;
      }),
    };
  }

  async ingestInventory(_config: ConnectorConfig, raw: unknown): Promise<Product[]> {
    const inv = (raw ?? {}) as { products?: KiboProduct[] };
    if (!Array.isArray(inv.products)) {
      throw new Error("kiboerp: invalid inventory payload: missing products array");
    }

    return inv.products.map((p) => {
      const code = str(p.code) || str(p.id);
      const product: Product = {
        local_sku: code || str(p.barcode),
        description: str(p.designation),
        unit_price: num(p.unitPrice),
        quantity_on_hand: num(p.stockQuantity),
        product_type: p.isService ? "service" : "product",
      };
      const taxRate = str(p.taxRate);
      if (taxRate) product.tax_rate_id = taxRate;
      return product;
    });
  }
}