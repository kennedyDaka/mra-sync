import { createFileRoute } from "@tanstack/react-router";
import { withSecurity } from "@/lib/mra/security.server";

export const Route = createFileRoute("/api/public/v1/inventory/adjustment-reasons")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        return withSecurity(request, async () => {
          const { handleGetAdjustmentReasons } = await import("@/lib/mra/inventory-handlers.server");
          return handleGetAdjustmentReasons(request);
        });
      },
    },
  },
});
