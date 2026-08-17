/**
 * Tally ERP connector (inbound adapter).
 * Normalizes native Tally voucher/stock payloads pushed via webhook.
 * Mappings ported from the OIH reference adapter (internal/adapters/tally.go).
 */
import type { ErpConnector, ConnectorConfig, Product, SubmitInvoicePayload } from "./base";
import { num, str } from "./normalizers";

interface TallyEntry {
  ledgerName?: unknown;
  amount?: unknown;
  isDeemedPositive?: unknown;
}

interface TallyInvLine {
  stockItemName?: unknown;
  barcode?: unknown;
  quantity?: unknown;
  rate?: unknown;
  amount?: unknown;
  unit?: unknown;
}

interface TallyVoucher {
  voucherNumber?: unknown;
  partyName?: unknown;
  partyGstin?: unknown;
  date?: unknown;
  voucherType?: unknown;
  ledgerEntries?: TallyEntry[];
  inventory?: TallyInvLine[];
}

interface TallyStockItem {
  name?: unknown;
  barcode?: unknown;
  category?: unknown;
  openingQty?: unknown;
  closingQty?: unknown;
  rate?: unknown;
  valuation?: unknown;
  unit?: unknown;
  gstTaxRate?: unknown;
}

export class TallyConnector implements ErpConnector {
  type = "tally";
  label = "Tally ERP";
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
    const voucher = (raw ?? {}) as TallyVoucher;
    if (!str(voucher.voucherNumber)) {
      throw new Error("tally: voucherNumber is required");
    }
    const lines = Array.isArray(voucher.inventory) ? voucher.inventory : [];

    let payment = "Cash";
    if (Array.isArray(voucher.ledgerEntries)) {
      for (const entry of voucher.ledgerEntries) {
        const ledger = str(entry.ledgerName).toLowerCase();
        if (num(entry.amount) > 0) {
          if (ledger === "bank" || ledger === "bank account") payment = "BankTransfer";
          else if (ledger === "cash") payment = "Cash";
        }
      }
    }

    return {
      erp_invoice_number: str(voucher.voucherNumber),
      buyer_name: str(voucher.partyName),
      customer_tin: str(voucher.partyGstin),
      payment_method: payment,
      line_items: lines.map((line) => ({
        erp_sku: str(line.stockItemName),
        description: str(line.stockItemName),
        quantity: num(line.quantity),
        unit_price: num(line.rate),
      })),
    };
  }

  async ingestInventory(_config: ConnectorConfig, raw: unknown): Promise<Product[]> {
    const inv = (raw ?? {}) as { stockItems?: TallyStockItem[] };
    if (!Array.isArray(inv.stockItems)) {
      throw new Error("tally: invalid inventory payload: missing stockItems array");
    }

    return inv.stockItems.map((item) => {
      const closing = num(item.closingQty);
      const qty = closing > 0 ? closing : num(item.openingQty);
      return {
        local_sku: str(item.name),
        description: str(item.name),
        unit_price: num(item.rate),
        quantity_on_hand: qty,
        product_type: "product",
      };
    });
  }
}