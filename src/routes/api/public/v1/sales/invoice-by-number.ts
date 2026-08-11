import { createFileRoute } from "@tanstack/react-router";
import { withSecurity } from "@/lib/mra/security.server";

export const Route = createFileRoute("/api/public/v1/sales/invoice-by-number")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        return withSecurity(request, async () => {
          const { handleGetInvoiceByNumber } = await import("@/lib/mra/inventory-handlers.server");
          return handleGetInvoiceByNumber(request);
        });
      },
    },
  },
});
