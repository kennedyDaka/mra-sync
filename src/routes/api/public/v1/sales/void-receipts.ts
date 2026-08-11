import { createFileRoute } from "@tanstack/react-router";
import { withSecurity } from "@/lib/mra/security.server";

export const Route = createFileRoute("/api/public/v1/sales/void-receipts")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        return withSecurity(request, async () => {
          const { handleGetVoidReceipts } = await import("@/lib/mra/handlers.server");
          return handleGetVoidReceipts(request);
        });
      },
    },
  },
});
