import { createFileRoute } from "@tanstack/react-router";
import { withSecurity } from "@/lib/mra/security.server";

/**
 * Catch-up pipeline daemon. Invoked on a schedule; drains the FIFO sync queue.
 * Protected by CRON_SECRET to prevent unauthorized access.
 */
export const Route = createFileRoute("/api/public/hooks/sync-worker")({
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
          try {
            const { handleQueueWorker } = await import("@/lib/mra/handlers.server");
            return await handleQueueWorker();
          } catch (err: any) {
            return new Response(JSON.stringify({ error: err.message ?? "internal error" }), {
              status: 500,
              headers: { "content-type": "application/json" },
            });
          }
        });
      },
    },
  },
});
