/**
 * SAP Business One connector (inbound adapter).
 * Normalizes native SAP B1 document/item payloads pushed via webhook.
 * Mappings ported from the OIH reference adapter (internal/adapters/sapb1.go).
 */
import type { ErpConnector, ConnectorConfig, Product, SubmitInvoicePayload } from "./base";
import { num, str } from "./normalizers";

interface SapB1Line {
  LineNum?: unknown;
  ItemCode?: unknown;
  ItemDescription?: unknown;
  Quantity?: unknown;
  UnitPrice?: unknown;
  LineTotal?: unknown;
  TaxCode?: unknown;
  WarehouseCode?: unknown;
  UoMCode?: unknown;
}

interface SapB1Document {
  DocEntry?: unknown;
  DocNum?: unknown;
  CardCode?: unknown;
  CardName?: unknown;
  DocDate?: unknown;
  DocTotal?: unknown;
  DocType?: unknown;
  DocumentLines?: SapB1Line[];
}

interface SapB1Item {
  ItemCode?: unknown;
  ItemName?: unknown;
  ItemsGroupName?: unknown;
  OnHand?: unknown;
  IsCommitted?: unknown;
  OnOrder?: unknown;
  UnitPrice?: unknown;
  AveragePrice?: unknown;
  VATGroup?: unknown;
  Barcode?: unknown;
  SupplierCode?: unknown;
  UoMCode?: unknown;
  ItemType?: unknown;
  ManagedBy?: unknown;
  QuantityOnHand?: unknown;
}

export class SapB1Connector implements ErpConnector {
  type = "sap-b1";
  label = "SAP Business One";
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
    const doc = (raw ?? {}) as SapB1Document;
    if (!Array.isArray(doc.DocumentLines)) {
      throw new Error("sap-b1: invalid sale payload: missing DocumentLines array");
    }
    if (!doc.DocNum) {
      throw new Error("sap-b1: DocNum is required");
    }

    return {
      erp_invoice_number: str(doc.DocNum),
      buyer_name: str(doc.CardName),
      customer_tin: str(doc.CardCode),
      payment_method: "BankTransfer",
      line_items: doc.DocumentLines.map((line) => ({
        erp_sku: str(line.ItemCode),
        description: str(line.ItemDescription),
        quantity: num(line.Quantity),
        unit_price: num(line.UnitPrice),
      })),
    };
  }

  async ingestInventory(_config: ConnectorConfig, raw: unknown): Promise<Product[]> {
    const inv = (raw ?? {}) as { items?: SapB1Item[] };
    if (!Array.isArray(inv.items)) {
      throw new Error("sap-b1: invalid inventory payload: missing items array");
    }

    return inv.items.map((item) => {
      const qtyStr = str(item.QuantityOnHand);
      const qty = qtyStr ? Number(qtyStr) : num(item.OnHand);
      return {
        local_sku: str(item.ItemCode),
        description: str(item.ItemName),
        unit_price: num(item.UnitPrice),
        quantity_on_hand: Number.isFinite(qty) ? qty : 0,
        product_type: "product",
      };
    });
  }
}