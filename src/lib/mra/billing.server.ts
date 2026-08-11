/**
 * Multi-store billing handlers.
 * MWK 30,000 per store per billing period.
 */
import { z } from "zod";
import { authenticateTenant, errorResponse, json } from "./http.server";
import type { SupabaseClient } from "@supabase/supabase-js";

async function getDb(): Promise<SupabaseClient> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as unknown as SupabaseClient;
}

/** Get the current billing period (YYYY-MM format). */
function getCurrentPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Auto-create billing entries for a store when it's created. */
export async function ensureBillingEntry(db: SupabaseClient, storeId: string, tenantId: string): Promise<void> {
  const period = getCurrentPeriod();
  await db
    .from("store_billing" as never)
    .upsert(
      {
        store_id: storeId,
        tenant_id: tenantId,
        billing_period: period,
        amount_mwk: 30000,
        status: "pending",
      },
      { onConflict: "store_id,billing_period" },
    );
}

/** List billing records for a tenant. */
export async function handleListBilling(request: Request): Promise<Response> {
  const db = await getDb();
  const auth = await authenticateTenant(db, request);
  if (!auth.ok) return auth.response;
  const ctx = auth.context;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: billing } = await (db as any)
    .from("store_billing")
    .select("id, store_id, billing_period, amount_mwk, status, paid_at, payment_reference, created_at")
    .eq("tenant_id", ctx.tenantId)
    .order("billing_period", { ascending: false });

  return json({ billing: billing ?? [] });
}

/** Admin: list all tenants' billing. */
export async function handleAdminBilling(request: Request): Promise<Response> {
  const db = await getDb();
  const auth = await authenticateTenant(db, request);
  if (!auth.ok) return auth.response;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: billing } = await (db as any)
    .from("store_billing")
    .select("id, store_id, tenant_id, billing_period, amount_mwk, status, paid_at, created_at")
    .order("billing_period", { ascending: false })
    .limit(500);

  return json({ billing: billing ?? [] });
}
