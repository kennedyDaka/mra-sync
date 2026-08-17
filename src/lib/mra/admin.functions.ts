import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { generateMac } from "./platform.server";

const createTenantInput = z.object({
  name: z.string().min(2).max(120),
  slug: z
    .string()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9-]+$/, "Use lowercase letters, numbers and dashes"),
  taxpayer_tin: z.string().max(40).optional(),
});

export const createTenant = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => createTenantInput.parse(input))
  .handler(async ({ data, context }) => {
    const { data: tenant, error } = await context.supabase
      .from("tenants")
      .insert({
        owner_user_id: context.userId,
        name: data.name,
        slug: data.slug,
        taxpayer_tin: data.taxpayer_tin ?? null,
      })
      .select("id, name, slug")
      .single();

    if (error) throw new Error(error.message);

    const { issueApiToken } = await import("@/lib/mra/handlers.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const token = await issueApiToken(supabaseAdmin as never, tenant.id, "default");

    const { auditLog } = await import("@/lib/mra/http.server");
    await auditLog(supabaseAdmin as never, {
      tenantId: tenant.id,
      actorId: context.userId,
      action: "tenant.create",
      resourceType: "tenant",
      resourceId: tenant.id,
      metadata: { name: data.name, slug: data.slug },
    });

    return { tenant, token };
  });

export const issueToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ tenant_id: z.string().uuid(), label: z.string().min(1).max(60) }).parse(input),
  )
  .handler(async ({ data, context }) => {
    const { data: owned } = await context.supabase
      .from("tenants")
      .select("id")
      .eq("id", data.tenant_id)
      .maybeSingle();
    if (!owned) throw new Error("Merchant not found");

    const { issueApiToken } = await import("@/lib/mra/handlers.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const token = await issueApiToken(supabaseAdmin as never, data.tenant_id, data.label);

    const { auditLog } = await import("@/lib/mra/http.server");
    await auditLog(supabaseAdmin as never, {
      tenantId: data.tenant_id,
      actorId: context.userId,
      action: "token.issue",
      resourceType: "api_token",
      metadata: { label: data.label },
    });

    return { token };
  });

export const retryInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ invoice_id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: invoice } = await context.supabase
      .from("invoices")
      .select("id, tenant_id")
      .eq("id", data.invoice_id)
      .maybeSingle();
    if (!invoice) throw new Error("Invoice not found");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin
      .from("sync_queue")
      .upsert(
        {
          tenant_id: invoice.tenant_id,
          invoice_id: invoice.id,
          status: "queued",
          run_after: new Date().toISOString(),
          attempts: 0,
          last_error: null,
        },
        { onConflict: "invoice_id" },
      );
    await supabaseAdmin.from("invoices").update({ status: "QUEUED" }).eq("id", invoice.id);
    return { queued: true };
  });

export const drainQueueNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { handleQueueWorker } = await import("@/lib/mra/handlers.server");
    const response = await handleQueueWorker();
    return (await response.json()) as Record<string, number>;
  });

/* --------------------------------------------- self-service store onboarding */

const storeInput = z.object({
  tenant_id: z.string().uuid(),
  code: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[A-Za-z0-9._-]+$/, "Use letters, numbers, dots, dashes or underscores"),
  name: z.string().trim().min(2).max(120),
  address: z.string().trim().max(240).optional(),
});

export const createStore = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => storeInput.parse(input))
  .handler(async ({ data, context }) => {
    // RLS scopes this insert to merchants the signed-in user owns.
    const { data: store, error } = await context.supabase
      .from("stores")
      .insert({
        tenant_id: data.tenant_id,
        code: data.code,
        name: data.name,
        address: data.address ?? null,
      })
      .select("id, code, name, address, is_active")
      .single();
    if (error) throw new Error(error.message);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { auditLog } = await import("@/lib/mra/http.server");
    await auditLog(supabaseAdmin as never, {
      tenantId: data.tenant_id,
      actorId: context.userId,
      action: "store.create",
      resourceType: "store",
      resourceId: store.id,
      metadata: { code: data.code, name: data.name },
    });

    // Auto-create billing entry for the new store
    const { ensureBillingEntry } = await import("@/lib/mra/billing.server");
    await ensureBillingEntry(supabaseAdmin as never, store.id, data.tenant_id);

    return { store };
  });

const activateInput = z.object({
  tenant_id: z.string().uuid(),
  store_id: z.string().uuid(),
  terminal_id: z.string().trim().min(1).max(80),
  tac: z
    .string()
    .trim()
    .min(8)
    .max(50)
    .transform((v) => v.toUpperCase()),
  mac_address: z.string().trim().max(17).optional(),
});

/**
 * Self-service terminal activation from the dashboard. Most POS/ERP products
 * have no activation screen, so the merchant pastes the TAC here and the
 * middleware performs both MRA onboarding steps on their behalf.
 */
export const activateTerminalSelfService = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => activateInput.parse(input))
  .handler(async ({ data, context }) => {
    const { data: store } = await context.supabase
      .from("stores")
      .select("id, code, tenant_id")
      .eq("id", data.store_id)
      .eq("tenant_id", data.tenant_id)
      .maybeSingle();
    if (!store) throw new Error("Store not found for this merchant");

    const { activateTerminalCore } = await import("@/lib/mra/handlers.server");
    const { readEnv } = await import("@/lib/mra/env.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const response = await activateTerminalCore(
      supabaseAdmin as never,
      readEnv(),
      store.tenant_id,
      {
        store_id: store.code,
        terminal_id: data.terminal_id,
        tac: data.tac,
        platform: {
          os_name: "Linux",
          os_version: "1.0",
          os_build: "1.0",
          // If the operator provides the real MAC of their POS machine, use it.
          // Otherwise, generate a deterministic one from the terminal identity
          // so MRA dev accepts it. In production, the POS should provide the
          // real MAC via the API activation endpoint.
          mac_address: data.mac_address || generateMac(store.code, data.terminal_id),
        },
      },
    );
    const body = (await response.json()) as Record<string, unknown>;

    if (!response.ok) {
      throw new Error(
        typeof body["message"] === "string" ? body["message"] : "Terminal activation failed",
      );
    }

    if (typeof body["terminal_uid"] === "string") {
      await supabaseAdmin
        .from("terminals")
        .update({ store_uid: store.id })
        .eq("id", body["terminal_uid"]);
    }

    const { auditLog } = await import("@/lib/mra/http.server");
    await auditLog(supabaseAdmin as never, {
      tenantId: store.tenant_id,
      actorId: context.userId,
      action: "terminal.activate",
      resourceType: "terminal",
      resourceId: String(body["terminal_uid"] ?? ""),
      metadata: {
        terminal_id: data.terminal_id,
        mra_terminal_id: String(body["mra_terminal_id"] ?? ""),
        position: Number(body["terminal_position"] ?? 0),
      },
    });

    return {
      terminal_uid: String(body["terminal_uid"] ?? ""),
      terminal_id: String(body["terminal_id"] ?? data.terminal_id),
      mra_terminal_id: String(body["mra_terminal_id"] ?? ""),
      taxpayer_id: Number(body["taxpayer_id"] ?? 0),
      terminal_position: Number(body["terminal_position"] ?? 0),
      mode: String(body["mode"] ?? ""),
    };
  });

/* --------------------------------------------- terminal operations (ops) */

const terminalInput = z.object({
  tenant_id: z.string().uuid(),
  terminal_id: z.string().trim().min(1).max(80),
});

/**
 * Request a fresh JWT + secret from MRA and re-seal them for the terminal.
 * Mirrors the public POST /api/public/v1/tenant/refresh-token endpoint.
 */
export const refreshTerminalToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => terminalInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { readEnv } = await import("@/lib/mra/env.server");
    const { callMra, MRA_PATHS, summarizeErrors } = await import("@/lib/mra/mra-client.server");
    const { loadCredentials, logMraCall } = await import("@/lib/mra/sales.server");
    const { sealSecret } = await import("@/lib/mra/crypto.server");
    const { auditLog } = await import("@/lib/mra/http.server");

    const { data: terminal } = await supabaseAdmin
      .from("terminals")
      .select("id, tenant_id")
      .eq("tenant_id", data.tenant_id)
      .eq("terminal_id", data.terminal_id)
      .maybeSingle();
    if (!terminal) throw new Error("Terminal not found for this merchant");

    const env = readEnv();
    const credentials = await loadCredentials(supabaseAdmin as never, env, terminal.id);
    if (!credentials) throw new Error("Terminal credentials are missing");

    // access_key_enc is NOT NULL — preserve the value stored at activation.
    const { data: existingSecret } = await supabaseAdmin
      .from("terminal_secrets")
      .select("access_key_enc")
      .eq("terminal_uid", terminal.id)
      .maybeSingle();

    const result = await callMra<{ terminalCredentials?: { jwtToken?: string; secretKey?: string } }>({
      env,
      path: MRA_PATHS.requestNewTerminalToken,
      payload: {},
      auth: { jwtToken: credentials.jwtToken, secretKey: credentials.secretKey },
    });
    await logMraCall(supabaseAdmin as never, {
      tenantId: data.tenant_id,
      terminalUid: terminal.id,
      endpoint: MRA_PATHS.requestNewTerminalToken,
      statusCode: result.httpStatus,
      durationMs: result.durationMs,
      ok: result.ok,
      request: "{}",
      response: result.raw || (result.error ?? ""),
    });
    if (!result.ok) throw new Error(summarizeErrors(result));

    const jwt = result.data?.terminalCredentials?.jwtToken;
    const secret = result.data?.terminalCredentials?.secretKey;
    if (jwt && secret) {
      // MRA rotates credentials on every refresh: the old JWT is revoked even if
      // this upsert fails, so a persistence failure MUST be surfaced (a silent
      // swallow leaves the terminal with credentials MRA no longer accepts).
      const { error: upsertError } = await supabaseAdmin.from("terminal_secrets").upsert(
        {
          terminal_uid: terminal.id,
          tenant_id: data.tenant_id,
          access_key_enc: String(existingSecret?.["access_key_enc"] ?? ""),
          secret_key_enc: await sealSecret(secret, env.masterKey, env.isProduction),
          session_token_enc: await sealSecret(jwt, env.masterKey, env.isProduction),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "terminal_uid" },
      );
      if (upsertError) throw new Error(`Failed to persist rotated credentials: ${upsertError.message}`);
      await supabaseAdmin
        .from("terminals")
        .update({ last_error: null })
        .eq("id", terminal.id);
    }

    await auditLog(supabaseAdmin as never, {
      tenantId: data.tenant_id,
      actorId: context.userId,
      action: "terminal.refresh-token",
      resourceType: "terminal",
      resourceId: terminal.id,
      metadata: { terminal_id: data.terminal_id },
    });

    return { refreshed: Boolean(jwt && secret), data: result.data ?? {} };
  });

/**
 * Retry the MRA activation confirmation handshake for a terminal stuck in
 * "pending" (activation succeeded, confirmation failed). Mirrors
 * POST /api/public/v1/tenant/confirm-activation.
 */
export const confirmActivationRetry = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => terminalInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { readEnv } = await import("@/lib/mra/env.server");
    const { callMra, MRA_PATHS, summarizeErrors } = await import("@/lib/mra/mra-client.server");
    const { loadCredentials, logMraCall } = await import("@/lib/mra/sales.server");
    const { hmacSha512Base64 } = await import("@/lib/mra/crypto.server");
    const { auditLog } = await import("@/lib/mra/http.server");

    const { data: terminal } = await supabaseAdmin
      .from("terminals")
      .select("id, tenant_id, activation_code, mra_terminal_ref")
      .eq("tenant_id", data.tenant_id)
      .eq("terminal_id", data.terminal_id)
      .maybeSingle();
    if (!terminal) throw new Error("Terminal not found for this merchant");
    const tac = (terminal as Record<string, unknown>)["activation_code"] as string | null;
    const mraRef = (terminal as Record<string, unknown>)["mra_terminal_ref"] as string | null;
    if (!tac) throw new Error("No activation code stored for this terminal");
    if (!mraRef) throw new Error("Terminal has no MRA terminal reference — activate it first");

    const env = readEnv();
    const credentials = await loadCredentials(supabaseAdmin as never, env, terminal.id);
    if (!credentials) throw new Error("Terminal credentials are missing");

    const signature = await hmacSha512Base64(credentials.secretKey, tac);
    const result = await callMra({
      env,
      path: MRA_PATHS.terminalActivatedConfirmation,
      payload: { terminalId: mraRef },
      auth: { xSignature: signature, jwtToken: credentials.jwtToken },
      timeoutMs: 20_000,
    });
    await logMraCall(supabaseAdmin as never, {
      tenantId: data.tenant_id,
      terminalUid: terminal.id,
      endpoint: MRA_PATHS.terminalActivatedConfirmation,
      statusCode: result.httpStatus,
      durationMs: result.durationMs,
      ok: result.ok,
      request: JSON.stringify({ terminalId: mraRef }),
      response: result.raw || (result.error ?? ""),
    });
    if (!result.ok) throw new Error(summarizeErrors(result));

    await supabaseAdmin
      .from("terminals")
      .update({
        status: "active",
        confirmed_at: new Date().toISOString(),
        is_blocked: false,
        blocking_message: null,
        last_error: null,
      })
      .eq("id", terminal.id);

    await auditLog(supabaseAdmin as never, {
      tenantId: data.tenant_id,
      actorId: context.userId,
      action: "terminal.confirm-activation",
      resourceType: "terminal",
      resourceId: terminal.id,
      metadata: { terminal_id: data.terminal_id },
    });

    return { confirmed: true };
  });

/**
 * Pull the MRA blocking message for a terminal and store it locally.
 * Mirrors POST /api/public/v1/utilities/blocking-message.
 */
export const getTerminalBlockingMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => terminalInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { readEnv } = await import("@/lib/mra/env.server");
    const { callMra, MRA_PATHS, summarizeErrors } = await import("@/lib/mra/mra-client.server");
    const { loadCredentials, logMraCall } = await import("@/lib/mra/sales.server");
    const { auditLog } = await import("@/lib/mra/http.server");

    const { data: terminal } = await supabaseAdmin
      .from("terminals")
      .select("id, tenant_id")
      .eq("tenant_id", data.tenant_id)
      .eq("terminal_id", data.terminal_id)
      .maybeSingle();
    if (!terminal) throw new Error("Terminal not found for this merchant");

    const env = readEnv();
    const credentials = await loadCredentials(supabaseAdmin as never, env, terminal.id);
    if (!credentials) throw new Error("Terminal credentials are missing");

    const result = await callMra({
      env,
      path: MRA_PATHS.terminalBlockingMessage,
      payload: {},
      auth: { jwtToken: credentials.jwtToken, secretKey: credentials.secretKey },
    });
    await logMraCall(supabaseAdmin as never, {
      tenantId: data.tenant_id,
      terminalUid: terminal.id,
      endpoint: MRA_PATHS.terminalBlockingMessage,
      statusCode: result.httpStatus,
      durationMs: result.durationMs,
      ok: result.ok,
      request: "{}",
      response: result.raw || (result.error ?? ""),
    });
    if (!result.ok) throw new Error(summarizeErrors(result));

    await supabaseAdmin
      .from("terminals")
      .update({
        blocking_message: result.data ? JSON.stringify(result.data) : null,
        last_error: null,
      })
      .eq("id", terminal.id);

    await auditLog(supabaseAdmin as never, {
      tenantId: data.tenant_id,
      actorId: context.userId,
      action: "terminal.blocking-message",
      resourceType: "terminal",
      resourceId: terminal.id,
      metadata: { terminal_id: data.terminal_id },
    });

    return { data: result.data ?? {} };
  });

/* --------------------------------------------- catalogue operations (ops) */

const mapProductInput = z.object({
  tenant_id: z.string().uuid(),
  local_sku: z.string().trim().min(1).max(80),
  mra_product_id: z.string().trim().min(1).max(80),
  description: z.string().trim().max(240).optional(),
  tax_category: z.string().trim().max(10).optional(),
});

/**
 * Manually map a local SKU to an MRA product ID (unblocks sales for that SKU).
 * Mirrors the rows written by POST /api/public/v1/inventory/sync.
 */
export const mapProduct = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => mapProductInput.parse(input))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { auditLog } = await import("@/lib/mra/http.server");

    const row: {
      tenant_id: string;
      local_sku: string;
      mra_product_id: string;
      description: string | null;
      product_type: string;
      auto_registered: boolean;
      tax_category?: string;
    } = {
      tenant_id: data.tenant_id,
      local_sku: data.local_sku,
      mra_product_id: data.mra_product_id,
      description: data.description ?? null,
      product_type: "product",
      auto_registered: false,
    };
    if (data.tax_category) row["tax_category"] = data.tax_category;

    const { error } = await supabaseAdmin
      .from("product_maps")
      .upsert(row, { onConflict: "tenant_id,local_sku" });
    if (error) throw new Error(error.message);

    await auditLog(supabaseAdmin as never, {
      tenantId: data.tenant_id,
      actorId: context.userId,
      action: "product.map",
      resourceType: "product_map",
      metadata: {
        local_sku: data.local_sku,
        mra_product_id: data.mra_product_id,
      },
    });

    return { mapped: true };
  });
