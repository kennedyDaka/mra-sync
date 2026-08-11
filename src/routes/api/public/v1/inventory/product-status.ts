import { createFileRoute } from "@tanstack/react-router";
import { withSecurity } from "@/lib/mra/security.server";

export const Route = createFileRoute("/api/public/v1/inventory/product-status")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        return withSecurity(request, async () => {
          const { handleProductStatus } = await import("@/lib/mra/inventory-handlers.server");
          return handleProductStatus(request);
        });
      },
    },
  },
});
