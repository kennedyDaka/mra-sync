/**
 * Base interface for ERP/POS connectors.
 * Each adapter implements this interface to bridge a specific ERP/POS system
 * with the MRA EIS middleware.
 */

export interface ConnectorConfig {
  [key: string]: string | number | boolean | undefined;
}

export interface Product {
  local_sku: string;
  description: string;
  unit_price: number;
  quantity_on_hand: number;
  tax_rate_id?: string;
  product_type: "product" | "service";
}

export interface InvoiceLineItem {
  erp_sku: string;
  description?: string;
  quantity: number;
  unit_price: number;
  discount?: number;
  tax_rate_id?: string;
}

export interface SubmitInvoicePayload {
  erp_invoice_number: string;
  cashier_id?: string;
  customer_tin?: string;
  buyer_name?: string;
  payment_method?: string;
  amount_tendered?: number;
  invoice_timestamp?: string;
  line_items: InvoiceLineItem[];
}

export interface SubmitResult {
  ok: boolean;
  mra_status?: string;
  receipt_code?: string | null;
  error?: string;
}

export interface StockLevel {
  local_sku: string;
  quantity: number;
  last_updated: string;
}

export interface Recipe {
  finished_product_code: string;
  finished_product_name: string;
  conversion_factor: number;
  unit_of_measure: string;
  items: RecipeItem[];
}

export interface RecipeItem {
  raw_material_code: string;
  raw_material_name: string;
  quantity_per_unit: number;
  unit_of_measure: string;
  waste_factor: number;
}

export interface ConversionRequest {
  production_batch_id?: string;
  production_date: string;
  raw_materials: {
    product_id: string;
    product_name: string;
    available_quantity: number;
    used_quantity: number;
  }[];
  finished_products: {
    barcode: string;
    product_description: string;
    quantity: number;
    unit_of_measure: string;
    expiry_date?: string;
  }[];
}

export interface ConversionResult {
  ok: boolean;
  batch_id?: string;
  error?: string;
}

/**
 * Base connector interface. All ERP/POS adapters implement this.
 */
export interface ErpConnector {
  /** Unique identifier (e.g., 'odoo', 'sage', 'quickbooks') */
  type: string;
  /** Human-readable name (e.g., 'Odoo ERP') */
  label: string;
  /** Authentication type */
  auth_type: "api_key" | "oauth2" | "basic" | "custom";
  /** JSON Schema describing the config fields needed */
  config_schema: Record<string, unknown>;

  /** Validate that the provided credentials work */
  validateCredentials(config: ConnectorConfig): Promise<boolean>;

  /** List products from the ERP/POS */
  listProducts(config: ConnectorConfig): Promise<Product[]>;

  /** Submit an invoice to the ERP/POS (or receive from it) */
  submitInvoice?(config: ConnectorConfig, invoice: SubmitInvoicePayload): Promise<SubmitResult>;

  /** Get current stock levels */
  getStockLevels?(config: ConnectorConfig): Promise<StockLevel[]>;

  /** Sync inventory (full refresh) */
  syncInventory?(config: ConnectorConfig): Promise<Product[]>;

  /** Get recipes/BOM definitions */
  getRecipes?(config: ConnectorConfig): Promise<Recipe[]>;

  /** Trigger raw material conversion */
  convertRawMaterial?(config: ConnectorConfig, conversion: ConversionRequest): Promise<ConversionResult>;

  /**
   * Normalize a native ERP/POS sale payload (pushed via webhook) into the
   * middleware sales schema. Implemented by inbound adapters (e.g. Aronium,
   * CliqPOS, Tally). Optional — connectors that only receive normalized
   * payloads (generic-rest, generic-webhook) skip it.
   */
  ingestSale?(config: ConnectorConfig, raw: unknown): Promise<SubmitInvoicePayload>;

  /**
   * Normalize a native ERP/POS inventory payload (pushed via webhook) into
   * product rows for `product_maps`. Optional.
   */
  ingestInventory?(config: ConnectorConfig, raw: unknown): Promise<Product[]>;
}
