import { createFileRoute } from "@tanstack/react-router";
import { withSecurity } from "@/lib/mra/security.server";

/**
 * Refreshes cached MRA configuration (tax brackets, version rules) per terminal.
 * Protected by CRON_SECRET to prevent unauthorized access.
 */
export const Route = createFileRoute("/api/public/hooks/config-sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        return withSecurity(request, async () => {
          const secret = request.headers.get("x-cron-secret") ?? "";
          if (!process.env["CRON_SECRET"] || secret !== process.env["CRON_SECRET"]) {
            return new Response(JSON.stringify({ error: "unauthorized" }), {
              status: 401,
              headers: { "content-type": "application/json" },
            });
          }
          const { handleConfigSync } = await import("@/lib/mra/handlers.server");
          return handleConfigSync();
        });
      },
    },
  },
});
