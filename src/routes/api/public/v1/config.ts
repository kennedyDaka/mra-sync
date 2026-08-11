import { createFileRoute } from "@tanstack/react-router";
import { withSecurity } from "@/lib/mra/security.server";

/**
 * Returns the current MRA configuration for a terminal: available tax rates,
 * taxpayer info, offline limits, and config versions. ERP/POS systems poll
 * this endpoint to auto-discover tax rates and stay in sync with the middleware.
 */
export const Route = createFileRoute("/api/public/v1/config")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        return withSecurity(request, async () => {
          const { handleGetConfig } = await import("@/lib/mra/handlers.server");
          return handleGetConfig(request);
        });
      },
    },
  },
});
