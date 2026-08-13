import { createFileRoute } from "@tanstack/react-router";
import { withSecurity } from "@/lib/mra/security.server";

/**
 * Vercel cron endpoint — processes pending ERP sync jobs.
 * Runs every 5 minutes via vercel.json cron configuration.
 * Protected by CRON_SECRET to prevent unauthorized triggering.
 */
export const Route = createFileRoute("/api/cron/sync-worker")({
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
            const { processSyncJobs } = await import("@/lib/mra/sync-worker.server");
            const result = await processSyncJobs();
            return new Response(JSON.stringify(result), {
              headers: { "content-type": "application/json" },
            });
          } catch (err: any) {
            console.error("[cron-sync] error:", err);
            return new Response(JSON.stringify({ error: err.message ?? "internal error" }), {
              status: 500,
              headers: { "content-type": "application/json" },
            });
          }
        });
      },
      // Vercel cron sends GET requests for health checks
      GET: async ({ request }) => {
        return withSecurity(request, async () => {
          const secret = request.headers.get("x-cron-secret") ?? "";
          if (!process.env["CRON_SECRET"] || secret !== process.env["CRON_SECRET"]) {
            return new Response(JSON.stringify({ error: "unauthorized" }), {
              status: 401,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response(JSON.stringify({ status: "ok", worker: "erp-sync" }), {
            headers: { "content-type": "application/json" },
          });
        });
      },
    },
  },
});
