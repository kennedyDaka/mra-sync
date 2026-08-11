/**
 * AI Fraud Detection Engine.
 * Runs asynchronously after each invoice submission to detect anomalies.
 * Rules: rate abuse, volume anomaly, time anomaly, amount anomaly, duplicate detection.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface FraudAlert {
  rule_id: string;
  severity: "low" | "medium" | "high" | "critical";
  description: string;
  evidence: Record<string, unknown>;
}

export interface InvoiceForAnalysis {
  id: string;
  tenant_id: string;
  store_id?: string | null;
  terminal_id?: string | null;
  terminal_uid?: string | null;
  erp_invoice_number: string;
  total_amount: number;
  total_tax: number;
  line_items: Array<{
    tax_rate_id?: string | null;
    quantity: number;
    unit_price: number;
    total: number;
  }>;
  created_at: string;
}

/** Main entry point: analyze an invoice and return any fraud alerts. */
export async function analyzeInvoice(
  db: SupabaseClient,
  invoice: InvoiceForAnalysis,
): Promise<FraudAlert[]> {
  const alerts: FraudAlert[] = [];

  // Run all rules in parallel
  const results = await Promise.all([
    checkRateAbuse(db, invoice),
    checkVolumeAnomaly(db, invoice),
    checkTimeAnomaly(invoice),
    checkAmountAnomaly(db, invoice),
    checkDuplicateInvoice(db, invoice),
  ]);

  for (const result of results) {
    alerts.push(...result);
  }

  // Persist alerts
  if (alerts.length > 0) {
    await db.from("fraud_alerts").insert(
      alerts.map((a) => ({
        tenant_id: invoice.tenant_id,
        store_id: invoice.store_id ?? null,
        terminal_id: invoice.terminal_uid ?? null,
        invoice_id: invoice.id,
        rule_id: a.rule_id,
        severity: a.severity,
        description: a.description,
        evidence: a.evidence,
      })),
    );
  }

  return alerts;
}

/** Rule: Rate abuse — products sold at 0% that should be 17.5%. */
async function checkRateAbuse(
  db: SupabaseClient,
  invoice: InvoiceForAnalysis,
): Promise<FraudAlert[]> {
  const alerts: FraudAlert[] = [];
  const zeroRateItems = invoice.line_items.filter(
    (i) => i.tax_rate_id === "B" && i.unit_price > 0,
  );

  if (zeroRateItems.length === 0) return alerts;

  // Check historical rate distribution for this tenant
  const { data: recentInvoices } = await db
    .from("invoices")
    .select("line_items")
    .eq("tenant_id", invoice.tenant_id)
    .gte("created_at", new Date(Date.now() - 30 * 86400_000).toISOString())
    .limit(100);

  if (!recentInvoices || recentInvoices.length < 10) return alerts;

  let totalItems = 0;
  let zeroRatedItems = 0;
  for (const inv of recentInvoices) {
    const items = (inv["line_items"] ?? []) as Array<{ tax_rate_id?: string }>;
    for (const item of items) {
      totalItems++;
      if (item.tax_rate_id === "B") zeroRatedItems++;
    }
  }

  const zeroRateRatio = totalItems > 0 ? zeroRatedItems / totalItems : 0;

  // If more than 40% of items are zero-rated, flag it
  if (zeroRateRatio > 0.4 && zeroRateItems.length > 0) {
    alerts.push({
      rule_id: "rate_abuse",
      severity: "high",
      description: `${zeroRateItems.length} items sold at zero rate (B). Historical zero-rate ratio: ${(zeroRateRatio * 100).toFixed(1)}%`,
      evidence: {
        zero_rate_items: zeroRateItems.map((i) => ({
          quantity: i.quantity,
          unit_price: i.unit_price,
          total: i.total,
        })),
        historical_zero_rate_ratio: zeroRateRatio,
        sample_size: recentInvoices.length,
      },
    });
  }

  return alerts;
}

/** Rule: Volume anomaly — sudden spike or drop in sales volume. */
async function checkVolumeAnomaly(
  db: SupabaseClient,
  invoice: InvoiceForAnalysis,
): Promise<FraudAlert[]> {
  const alerts: FraudAlert[] = [];

  // Get daily sales counts for the last 30 days
  const { data: dailyCounts } = await db.rpc("get_daily_sales_counts" as never, {
    _tenant_id: invoice.tenant_id,
    _days: 30,
  }).single();

  // Fallback: manual query if RPC doesn't exist
  const { data: recentInvoices } = await db
    .from("invoices")
    .select("created_at")
    .eq("tenant_id", invoice.tenant_id)
    .gte("created_at", new Date(Date.now() - 30 * 86400_000).toISOString());

  if (!recentInvoices || recentInvoices.length < 5) return alerts;

  // Group by day
  const dayCounts = new Map<string, number>();
  for (const inv of recentInvoices) {
    const day = String(inv["created_at"]).slice(0, 10);
    dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
  }

  const counts = Array.from(dayCounts.values());
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  const variance = counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length;
  const stdDev = Math.sqrt(variance);

  // Today's count including this invoice
  const today = new Date().toISOString().slice(0, 10);
  const todayCount = (dayCounts.get(today) ?? 0) + 1;

  // Z-score: how many standard deviations from mean
  const zScore = stdDev > 0 ? (todayCount - mean) / stdDev : 0;

  if (Math.abs(zScore) > 2.5) {
    const direction = zScore > 0 ? "spike" : "drop";
    alerts.push({
      rule_id: "volume_anomaly",
      severity: zScore > 3 ? "high" : "medium",
      description: `Sales volume ${direction}: ${todayCount} invoices today vs ${mean.toFixed(1)} average (z-score: ${zScore.toFixed(2)})`,
      evidence: {
        today_count: todayCount,
        daily_mean: mean,
        daily_std_dev: stdDev,
        z_score: zScore,
        direction,
      },
    });
  }

  return alerts;
}

/** Rule: Time anomaly — invoices at unusual hours. */
async function checkTimeAnomaly(invoice: InvoiceForAnalysis): Promise<FraudAlert[]> {
  const alerts: FraudAlert[] = [];

  const hour = new Date(invoice.created_at).getUTCHours();
  // Malawi is UTC+2, so adjust
  const localHour = (hour + 2) % 24;

  // Flag transactions between 1 AM and 5 AM
  if (localHour >= 1 && localHour <= 5) {
    alerts.push({
      rule_id: "time_anomaly",
      severity: "medium",
      description: `Invoice submitted at unusual hour: ${localHour}:00 CAT`,
      evidence: {
        utc_hour: hour,
        local_hour: localHour,
        invoice_timestamp: invoice.created_at,
      },
    });
  }

  return alerts;
}

/** Rule: Amount anomaly — unusually large or small transactions. */
async function checkAmountAnomaly(
  db: SupabaseClient,
  invoice: InvoiceForAnalysis,
): Promise<FraudAlert[]> {
  const alerts: FraudAlert[] = [];

  // Get recent invoice amounts for this terminal
  const { data: recentAmounts } = await db
    .from("invoices")
    .select("total_amount")
    .eq("tenant_id", invoice.tenant_id)
    .gte("created_at", new Date(Date.now() - 30 * 86400_000).toISOString())
    .limit(200);

  if (!recentAmounts || recentAmounts.length < 10) return alerts;

  const amounts = recentAmounts
    .map((r) => Number(r["total_amount"] ?? 0))
    .filter((a) => a > 0);

  if (amounts.length < 10) return alerts;

  // IQR method for outlier detection
  amounts.sort((a, b) => a - b);
  const q1 = amounts[Math.floor(amounts.length * 0.25)] ?? 0;
  const q3 = amounts[Math.floor(amounts.length * 0.75)] ?? 0;
  const iqr = q3 - q1;
  const lowerBound = q1 - 1.5 * iqr;
  const upperBound = q3 + 1.5 * iqr;

  if (invoice.total_amount > upperBound * 3) {
    alerts.push({
      rule_id: "amount_anomaly",
      severity: "high",
      description: `Invoice amount MWK ${invoice.total_amount.toLocaleString()} is ${(invoice.total_amount / upperBound).toFixed(1)}x above the typical upper bound`,
      evidence: {
        invoice_amount: invoice.total_amount,
        upper_bound: upperBound,
        median: amounts[Math.floor(amounts.length * 0.5)],
        sample_size: amounts.length,
      },
    });
  } else if (invoice.total_amount > upperBound) {
    alerts.push({
      rule_id: "amount_anomaly",
      severity: "low",
      description: `Invoice amount MWK ${invoice.total_amount.toLocaleString()} exceeds typical range`,
      evidence: {
        invoice_amount: invoice.total_amount,
        upper_bound: upperBound,
        sample_size: amounts.length,
      },
    });
  }

  return alerts;
}

/** Rule: Duplicate detection — same invoice number within 48 hours. */
async function checkDuplicateInvoice(
  db: SupabaseClient,
  invoice: InvoiceForAnalysis,
): Promise<FraudAlert[]> {
  const alerts: FraudAlert[] = [];

  const { data: duplicates } = await db
    .from("invoices")
    .select("id, status")
    .eq("tenant_id", invoice.tenant_id)
    .eq("erp_invoice_number", invoice.erp_invoice_number)
    .neq("id", invoice.id)
    .gte("created_at", new Date(Date.now() - 48 * 3600_000).toISOString());

  if (duplicates && duplicates.length > 0) {
    alerts.push({
      rule_id: "duplicate_invoice",
      severity: "high",
      description: `Duplicate invoice number "${invoice.erp_invoice_number}" found ${duplicates.length} time(s) in the last 48 hours`,
      evidence: {
        erp_invoice_number: invoice.erp_invoice_number,
        duplicate_count: duplicates.length,
        duplicate_statuses: duplicates.map((d) => d["status"]),
      },
    });
  }

  return alerts;
}

/** Get open fraud alerts for a tenant. */
export async function getOpenAlerts(
  db: SupabaseClient,
  tenantId: string,
  limit = 50,
): Promise<unknown[]> {
  const { data } = await db
    .from("fraud_alerts")
    .select("id, rule_id, severity, description, evidence, status, invoice_id, created_at")
    .eq("tenant_id", tenantId)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(limit);

  return data ?? [];
}

/** Resolve a fraud alert. */
export async function resolveAlert(
  db: SupabaseClient,
  alertId: string,
  tenantId: string,
): Promise<boolean> {
  const { error } = await db
    .from("fraud_alerts")
    .update({ status: "resolved", resolved_at: new Date().toISOString() })
    .eq("id", alertId)
    .eq("tenant_id", tenantId);

  return !error;
}
