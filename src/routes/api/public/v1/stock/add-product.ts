import { createFileRoute } from "@tanstack/react-router";
import { withSecurity } from "@/lib/mra/security.server";

export const Route = createFileRoute("/api/public/v1/stock/add-product")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        return withSecurity(request, async () => {
          const { handleAddProduct } = await import("@/lib/mra/inventory-handlers.server");
          return handleAddProduct(request);
        });
      },
    },
  },
});
