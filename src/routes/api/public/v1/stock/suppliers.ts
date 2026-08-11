import { createFileRoute } from "@tanstack/react-router";
import { withSecurity } from "@/lib/mra/security.server";

export const Route = createFileRoute("/api/public/v1/stock/suppliers")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        return withSecurity(request, async () => {
          const { handleGetSuppliers } = await import("@/lib/mra/inventory-handlers.server");
          return handleGetSuppliers(request);
        });
      },
    },
  },
});
