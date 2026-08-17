/**
 * Shared normalizers for inbound ERP/POS adapters.
 * Field mappings are ported from the OIH reference implementation
 * (internal/adapters/*) so native payloads from each system map to the
 * middleware's canonical shapes.
 */
import type { Product } from "./base";

/** Coerce unknown → number, defaulting to 0. */
export function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Coerce unknown → trimmed string. */
export function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

/**
 * Map vendor payment labels to canonical middleware payment methods
 * (Cash / Card / MobileMoney / BankTransfer / Check / Credit).
 */
export function mapPaymentMethod(payment: string): string {
  switch (payment) {
    case "Cash":
    case "CASH":
    case "ESPECES":
      return "Cash";
    case "Card":
    case "CARD":
    case "CB":
    case "CREDIT_CARD":
    case "DebitCard":
      return "Card";
    case "MobileMoney":
    case "MOBILE_MONEY":
    case "MoMo":
    case "AirtelMoney":
    case "Airtel Money":
    case "AIRTEL_MONEY":
    case "M-Pesa":
    case "MPESA":
    case "mpesa":
    case "MTN MoMo":
    case "MTN_MOMO":
    case "MTN":
    case "momo":
    case "Orange Money":
    case "ORANGE_MONEY":
    case "OM":
    case "Wave":
    case "WAVE":
      return "MobileMoney";
    case "Check":
    case "CHEQUE":
      return "Check";
    case "Credit":
    case "CREDIT":
      return "Credit";
    case "BankTransfer":
    case "TRANSFER":
    case "Bank Transfer":
    case "VIREMENT":
    case "bank":
    case "bank account":
      return "BankTransfer";
    default:
      return "Cash";
  }
}

/**
 * Map vendor VAT labels to official MRA tax rate ids (A = VAT-A 16.5%,
 * B = zero rated, C/E = exempt, etc.).
 */
export function mapTaxRate(vatRate: string): string {
  switch (vatRate) {
    case "A":
    case "STANDARD":
    case "16.5":
    case "16":
    case "VAT":
      return "A";
    case "B":
    case "ZERO":
    case "0":
    case "0%":
      return "B";
    case "C":
    case "EXEMPT":
    case "EXEMPTED":
      return "C";
    case "D":
    case "E":
    case "SPECIAL":
      return "E";
    default:
      return "A";
  }
}

/**
 * Decode a Sage-style inventory CSV export (header row + data rows) into
 * product rows. Header names are matched loosely (case-insensitive) with
 * several aliases per column, mirroring the OIH Sage adapter.
 */
export function csvToInventory(csv: string): Product[] {
  const rows = csv.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (rows.length < 2) return [];

  const parse = (value: string): string => {
    const v = value.trim();
    if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/""/g, '"');
    return v;
  };

  const headers = splitCsvRow(rows[0] ?? "").map((h) => h.trim().toLowerCase());
  const col = (row: string[], names: string[]): string => {
    for (const name of names) {
      const idx = headers.indexOf(name);
      if (idx >= 0 && idx < row.length) {
        const cell = row[idx];
        if (cell !== undefined) return parse(cell);
      }
    }
    return "";
  };

  const items: Product[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = splitCsvRow(rows[i] ?? "");
    if (row.length < 2) continue;

    const code = col(row, ["itemcode", "item_code", "code", "sku", "stockcode"]);
    if (!code) continue;

    const description = col(row, ["description", "itemdescription", "item_description", "name", "productname"]) || code;
    const barcode = col(row, ["barcode", "barcode1", "ean", "upc"]);
    const qty = Number(col(row, ["qtyonhand", "qty_on_hand", "quantity_on_hand", "stock", "quantity"])) || 0;
    const price = Number(col(row, ["unitprice", "unit_price", "sellingprice", "selling_price", "price"])) || 0;
    const cost = Number(col(row, ["costprice", "cost_price", "cost", "unitcost"])) || 0;

    items.push({
      local_sku: barcode || code,
      description,
      unit_price: price,
      quantity_on_hand: qty,
      product_type: "product",
    });
  }
  return items;
}

/** Minimal RFC-4180-aware CSV row splitter (handles quoted fields). */
function splitCsvRow(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}