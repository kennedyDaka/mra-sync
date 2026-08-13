import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

/** List all available connector types. */
export const listConnectors = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { listConnectors: getList } = await import("@/lib/connectors/registry");
    return { connectors: getList() };
  });

/** Get tenant's configured connectors. */
const getTenantConnectors = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ tenant_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data, context }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: connectors } = await (context.supabase as any)
      .from("tenant_connectors")
      .select("id, connector_type, sync_mode, is_active, last_sync_at, created_at")
      .eq("tenant_id", data.tenant_id)
      .order("created_at", { ascending: false });

    return { connectors: connectors ?? [] };
  });

/** Test a connector's credentials. */
const testConnector = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({
      connector_type: z.string().min(1),
      config: z.record(z.union([z.string(), z.number(), z.boolean()])),
    }).parse(input),
  )
  .handler(async ({ data }) => {
    const { getConnector } = await import("@/lib/connectors/registry");
    const connector = getConnector(data.connector_type);
    if (!connector) {
      throw new Error(`Unknown connector type: ${data.connector_type}`);
    }

    const valid = await connector.validateCredentials(data.config);
    return { valid };
  });

/** Save a connector configuration for a tenant. */
const saveConnector = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({
      tenant_id: z.string().uuid(),
      connector_type: z.string().min(1),
      config: z.record(z.union([z.string(), z.number(), z.boolean()])),
      sync_mode: z.enum(["auto", "manual", "webhook"]).default("auto"),
    }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { getConnector } = await import("@/lib/connectors/registry");
    const { sealSecret } = await import("@/lib/mra/crypto.server");
    const { readEnv } = await import("@/lib/mra/env.server");

    const connector = getConnector(data.connector_type);
    if (!connector) {
      throw new Error(`Unknown connector type: ${data.connector_type}`);
    }

    const env = readEnv();
    const configStr = JSON.stringify(data.config);
    const encrypted = await sealSecret(configStr, env.masterKey, env.isProduction);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (context.supabase as any)
      .from("tenant_connectors")
      .upsert(
        {
          tenant_id: data.tenant_id,
          connector_type: data.connector_type,
          config_encrypted: encrypted,
          sync_mode: data.sync_mode,
          is_active: true,
        },
        { onConflict: "tenant_id,connector_type" },
      );

    if (error) throw new Error(error.message);
    return { saved: true };
  });

/** Delete a tenant's connector configuration. */
const deleteConnector = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({
      tenant_id: z.string().uuid(),
      connector_type: z.string().min(1),
    }).parse(input),
  )
  .handler(async ({ data, context }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (context.supabase as any)
      .from("tenant_connectors")
      .delete()
      .eq("tenant_id", data.tenant_id)
      .eq("connector_type", data.connector_type);

    if (error) throw new Error(error.message);
    return { deleted: true };
  });

/** Trigger a sync job for a tenant's connector. */
const triggerSync = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({
      tenant_id: z.string().uuid(),
      connector_type: z.string().min(1),
      job_type: z.enum(["product_sync", "invoice_push", "inventory_sync"]),
    }).parse(input),
  )
  .handler(async ({ data, context }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (context.supabase as any)
      .from("sync_jobs")
      .insert({
        tenant_id: data.tenant_id,
        connector_type: data.connector_type,
        job_type: data.job_type,
        status: "pending",
      });

    if (error) throw new Error(error.message);
    return { queued: true };
  });

export const Route = createFileRoute("/api/ops/v1/connectors")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { withSecurity } = await import("@/lib/mra/security.server");
        const { listConnectors: getList } = await import("@/lib/connectors/registry");
        return withSecurity(request, async () => {
          return new Response(JSON.stringify({ connectors: getList() }), {
            headers: { "content-type": "application/json" },
          });
        });
      },
    },
  },
});

export {
  getTenantConnectors,
  testConnector,
  saveConnector,
  deleteConnector,
  triggerSync,
};
