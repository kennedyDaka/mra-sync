import { createFileRoute } from "@tanstack/react-router";
import { withSecurity } from "@/lib/mra/security.server";

export const Route = createFileRoute("/api/public/v1/utilities/validate-vat5")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        return withSecurity(request, async () => {
          const { handleValidateVat5 } = await import("@/lib/mra/handlers.server");
          return handleValidateVat5(request);
        });
      },
    },
  },
});
