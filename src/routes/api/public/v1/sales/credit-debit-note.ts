import { createFileRoute } from "@tanstack/react-router";
import { withSecurity } from "@/lib/mra/security.server";

export const Route = createFileRoute("/api/public/v1/sales/credit-debit-note")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        return withSecurity(request, async () => {
          const { handleCreditDebitNote } = await import("@/lib/mra/inventory-handlers.server");
          return handleCreditDebitNote(request);
        });
      },
    },
  },
});
