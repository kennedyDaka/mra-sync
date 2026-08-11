import { createFileRoute } from "@tanstack/react-router";
import { withSecurity } from "@/lib/mra/security.server";

export const Route = createFileRoute("/api/public/v1/inventory/transfer")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        return withSecurity(request, async () => {
          const { handleTransferInventory } = await import("@/lib/mra/inventory-handlers.server");
          return handleTransferInventory(request);
        });
      },
    },
  },
});
