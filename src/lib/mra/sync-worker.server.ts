/**
 * ERP Sync Worker — processes pending sync jobs from the sync_jobs table.
 * Routes to the correct connector based on connector_type, executes the sync,
 * and updates job status.
 *
 * Runs via Vercel cron every 5 minutes, or can be triggered manually.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { readEnv } from "./env.server";
import { openSecret } from "./crypto.server";

async function getDb(): Promise<SupabaseClient> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as unknown as SupabaseClient;
}

interface SyncJob {
  id: number;
  tenant_id: string;
  connector_type: string;
  job_type: string;
  status: string;
  payload: Record<string, unknown> | null;
}

/**
 * Main entry point — picks up pending jobs and processes them.
 */
export async function processSyncJobs(): Promise<{
  processed: number;
  succeeded: number;
  failed: number;
  errors: string[];
}> {
  const db = await getDb();
  const env = readEnv();

  // Claim pending jobs (limit 10 per run to avoid timeout)
  const { data: jobs, error: claimError } = await db
    .from("sync_jobs")
    .select("id, tenant_id, connector_type, job_type, status, payload")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(10);

  if (claimError) {
    console.error("[sync-worker] Failed to query jobs:", claimError.message);
    return { processed: 0, succeeded: 0, failed: 0, errors: [claimError.message] };
  }

  if (!jobs || jobs.length === 0) {
    return { processed: 0, succeeded: 0, failed: 0, errors: [] };
  }

  let succeeded = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const job of jobs) {
    // Mark as processing
    await db
      .from("sync_jobs")
      .update({ status: "processing", started_at: new Date().toISOString() })
      .eq("id", job.id);

    try {
      await processJob(db, env, job as SyncJob);
      await db
        .from("sync_jobs")
        .update({
          status: "done",
          completed_at: new Date().toISOString(),
          result: { ok: true },
        })
        .eq("id", job.id);
      succeeded += 1;
    } catch (err: any) {
      const errorMsg = err.message ?? "unknown error";
      console.error(`[sync-worker] Job ${job.id} failed:`, errorMsg);
      await db
        .from("sync_jobs")
        .update({
          status: "failed",
          completed_at: new Date().toISOString(),
          error: errorMsg,
        })
        .eq("id", job.id);
      failed += 1;
      errors.push(`Job ${job.id}: ${errorMsg}`);
    }
  }

  return { processed: jobs.length, succeeded, failed, errors };
}

/**
 * Process a single sync job by routing to the correct connector.
 */
async function processJob(
  db: SupabaseClient,
  env: ReturnType<typeof readEnv>,
  job: SyncJob,
): Promise<void> {
  // Load the tenant's connector configuration
  const { data: connectorConfig, error: connError } = await db
    .from("tenant_connectors")
    .select("config_encrypted, sync_mode")
    .eq("tenant_id", job.tenant_id)
    .eq("connector_type", job.connector_type)
    .eq("is_active", true)
    .maybeSingle();

  if (connError || !connectorConfig) {
    throw new Error(
      `No active connector found for tenant ${job.tenant_id}, type ${job.connector_type}`,
    );
  }

  // Decrypt the connector config
  const configStr = await openSecret(
    connectorConfig.config_encrypted as string,
    env.masterKey,
  );
  const config = JSON.parse(configStr) as Record<string, string | number | boolean>;

  // Import the connector from registry
  const { getConnector } = await import("@/lib/connectors/registry");
  const connector = getConnector(job.connector_type);
  if (!connector) {
    throw new Error(`Unknown connector type: ${job.connector_type}`);
  }

  // Route based on job_type
  switch (job.job_type) {
    case "product_sync":
      await syncProducts(db, job.tenant_id, connector, config);
      break;

    case "inventory_sync":
      await syncInventory(db, job.tenant_id, connector, config);
      break;

    case "invoice_push":
      // Invoice push is handled inline during sales submission, not via cron
      // This job type exists for manual retry scenarios
      console.log(`[sync-worker] Invoice push job ${job.id} — handled at submission time`);
      break;

    default:
      throw new Error(`Unknown job type: ${job.job_type}`);
  }
}

/**
 * Pull products from ERP and sync to middleware's product_maps table.
 */
async function syncProducts(
  db: SupabaseClient,
  tenantId: string,
  connector: { listProducts: (config: Record<string, string | number | boolean>) => Promise<Array<{ local_sku: string; description: string; unit_price: number; quantity_on_hand: number; tax_rate_id?: string; product_type: string }>> },
  config: Record<string, string | number | boolean>,
): Promise<void> {
  const products = await connector.listProducts(config);

  let imported = 0;
  for (const product of products) {
    if (!product.local_sku) continue;

    const { error } = await db.from("product_maps").upsert(
      {
        tenant_id: tenantId,
        local_sku: product.local_sku,
        description: product.description,
        unit_price: product.unit_price,
        quantity_on_hand: product.quantity_on_hand,
        product_type: product.product_type,
        tax_rate_id: product.tax_rate_id ?? "A",
        source: "erp_sync",
      },
      { onConflict: "tenant_id,local_sku" },
    );

    if (!error) imported += 1;
  }

  console.log(`[sync-worker] Product sync: ${imported}/${products.length} imported for tenant ${tenantId}`);
}

/**
 * Pull stock levels from ERP and update product_maps quantity_on_hand.
 */
async function syncInventory(
  db: SupabaseClient,
  tenantId: string,
  connector: { getStockLevels?: (config: Record<string, string | number | boolean>) => Promise<Array<{ local_sku: string; quantity: number; last_updated: string }>> },
  config: Record<string, string | number | boolean>,
): Promise<void> {
  if (!connector.getStockLevels) {
    throw new Error("Connector does not support stock level sync");
  }

  const stockLevels = await connector.getStockLevels(config);

  let updated = 0;
  for (const stock of stockLevels) {
    if (!stock.local_sku) continue;

    const { error } = await db
      .from("product_maps")
      .update({
        quantity_on_hand: stock.quantity,
      })
      .eq("tenant_id", tenantId)
      .eq("local_sku", stock.local_sku);

    if (!error) updated += 1;
  }

  console.log(`[sync-worker] Inventory sync: ${updated}/${stockLevels.length} updated for tenant ${tenantId}`);
}

/**
 * Push an invoice from middleware to ERP (called at submission time, not via cron).
 */
export async function pushInvoiceToErp(
  db: SupabaseClient,
  tenantId: string,
  connectorType: string,
  invoice: {
    erp_invoice_number: string;
    line_items: Array<{
      erp_sku: string;
      description?: string;
      quantity: number;
      unit_price: number;
      discount?: number;
      tax_rate_id?: string;
    }>;
    payment_method?: string;
    customer_tin?: string;
    buyer_name?: string;
  },
): Promise<{ ok: boolean; error?: string }> {
  const env = readEnv();

  // Load connector config
  const { data: connectorConfig } = await db
    .from("tenant_connectors")
    .select("config_encrypted")
    .eq("tenant_id", tenantId)
    .eq("connector_type", connectorType)
    .eq("is_active", true)
    .maybeSingle();

  if (!connectorConfig) {
    return { ok: false, error: "No active connector" };
  }

  const configStr = await openSecret(
    connectorConfig.config_encrypted as string,
    env.masterKey,
  );
  const config = JSON.parse(configStr) as Record<string, string | number | boolean>;

  const { getConnector } = await import("@/lib/connectors/registry");
  const connector = getConnector(connectorType);
  if (!connector?.submitInvoice) {
    return { ok: false, error: "Connector does not support invoice submission" };
  }

  try {
    const result = await connector.submitInvoice(config, invoice);
    return { ok: result.ok, error: result.error };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}
