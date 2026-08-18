import { createFileRoute } from "@tanstack/react-router";
import { withSecurity } from "@/lib/mra/security.server";

/**
 * Terminal discovery — lets a POS learn its registered terminals (and their
 * status) so it can pick the right X-Terminal-ID before submitting sales.
 * Authenticated with the tenant Bearer token.
 */
export const Route = createFileRoute("/api/public/v1/terminals")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        return withSecurity(request, async () => {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { authenticateTenant, json } = await import("@/lib/mra/http.server");

          const db = supabaseAdmin as unknown as import("@supabase/supabase-js").SupabaseClient;
          const auth = await authenticateTenant(db, request);
          if (!auth.ok) return auth.response;

          const { data, error } = await db
            .from("terminals")
            .select(
              "terminal_id, store_id, status, terminal_position, is_blocked, activated_at, last_config_sync_at, mra_terminal_ref",
            )
            .eq("tenant_id", auth.context.tenantId)
            .order("created_at", { ascending: true });

          if (error) return json({ error: error.message }, 500);
          return json({ terminals: data ?? [] });
        });
      },
    },
  },
});
