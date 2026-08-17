import { createFileRoute } from "@tanstack/react-router";
import { withSecurity } from "@/lib/mra/security.server";

export const Route = createFileRoute("/api/ops/v1/billing")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        return withSecurity(request, async () => {
          const { handleAdminBilling } = await import("@/lib/mra/billing.server");
          return handleAdminBilling(request);
        });
      },
    },
  },
});