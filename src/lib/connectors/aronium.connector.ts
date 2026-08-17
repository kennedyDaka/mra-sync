/**
 * Aronium POS connector (inbound adapter).
 * Normalizes native Aronium sale/inventory payloads pushed via webhook.
 * Mappings ported from the OIH reference adapter (internal/adapters/aronium.go).
 */
import type { ErpConnector, ConnectorConfig, Product, SubmitInvoicePayload } from "./base";
import { mapPaymentMethod, mapTaxRate, num, str } from "./normalizers";

interface AroniumItem {
  ProductName?: unknown;
  Barcode?: unknown;
  Quantity?: unknown;
  UnitPrice?: unknown;
  TotalPrice?: unknown;
  VatRate?: unknown;
  Category?: unknown;
  VatAmount?: unknown;
}

interface AroniumSale {
  TransactionId?: unknown;
  ReceiptNumber?: unknown;
  TerminalName?: unknown;
  CustomerName?: unknown;
  CustomerTaxId?: unknown;
  PaymentType?: unknown;
  PaymentAmount?: unknown;
  Items?: AroniumItem[];
}

interface AroniumInventoryItem {
  Name?: unknown;
  Barcode?: unknown;
  Sku?: unknown;
  Category?: unknown;
  StockQuantity?: unknown;
  Price?: unknown;
  CostPrice?: unknown;
  VatRate?: unknown;
  IsService?: unknown;
}

export class AroniumConnector implements ErpConnector {
  type = "aronium";
  label = "Aronium POS";
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
    const sale = (raw ?? {}) as AroniumSale;
    if (!Array.isArray(sale.Items)) {
      throw new Error("aronium: invalid sale payload: missing Items array");
    }
    if (!str(sale.ReceiptNumber)) {
      throw new Error("aronium: receiptNumber is required");
    }

    return {
      erp_invoice_number: str(sale.ReceiptNumber),
      buyer_name: str(sale.CustomerName),
      customer_tin: str(sale.CustomerTaxId),
      payment_method: mapPaymentMethod(str(sale.PaymentType)),
      line_items: sale.Items.map((item) => ({
        erp_sku: str(item.Barcode) || str(item.ProductName),
        description: str(item.ProductName),
        quantity: num(item.Quantity),
        unit_price: num(item.UnitPrice),
        tax_rate_id: mapTaxRate(str(item.VatRate)),
      })),
    };
  }

  async ingestInventory(_config: ConnectorConfig, raw: unknown): Promise<Product[]> {
    const inv = (raw ?? {}) as { Products?: AroniumInventoryItem[] };
    if (!Array.isArray(inv.Products)) {
      throw new Error("aronium: invalid inventory payload: missing Products array");
    }

    return inv.Products.map((item) => ({
      local_sku: str(item.Sku) || str(item.Barcode),
      description: str(item.Name),
      unit_price: num(item.Price),
      quantity_on_hand: num(item.StockQuantity),
      product_type: item.IsService ? "service" : "product",
      tax_rate_id: mapTaxRate(str(item.VatRate)),
    }));
  }
}