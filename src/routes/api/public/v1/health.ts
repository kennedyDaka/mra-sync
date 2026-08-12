import { createFileRoute } from "@tanstack/react-router";
import { withSecurity } from "@/lib/mra/security.server";

/** Liveness + MRA gateway reachability probe. No credentials required. */
export const Route = createFileRoute("/api/public/v1/health")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        return withSecurity(request, async () => {
          const { readEnv } = await import("@/lib/mra/env.server");
          const env = readEnv();

          const started = Date.now();
          let gateway = "unreachable";
          try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), env.timeoutMs);
            const res = await fetch(`${env.baseUrl}/api/v1/configuration/latest`, {
              method: "GET",
              signal: controller.signal,
            });
            clearTimeout(timer);
            gateway = res.status < 500 ? "reachable" : "degraded";
          } catch {
            gateway = "unreachable";
          }

          return new Response(
            JSON.stringify({
              status: "ok",
              mode: env.mode,
              mra_base_url: env.baseUrl,
              mra_gateway: gateway,
              probe_ms: Date.now() - started,
              timestamp: new Date().toISOString(),
            }),
            { headers: { "content-type": "application/json" } },
          );
        });
      },
    },
  },
});
