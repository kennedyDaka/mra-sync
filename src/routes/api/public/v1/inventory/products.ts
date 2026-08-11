import { createFileRoute } from "@tanstack/react-router";
import { withSecurity } from "@/lib/mra/security.server";

export const Route = createFileRoute("/api/public/v1/inventory/products")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        return withSecurity(request, async () => {
          const { handleProductPull } = await import("@/lib/mra/handlers.server");
          return handleProductPull(request);
        });
      },
    },
  },
});
