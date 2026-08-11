import { createFileRoute } from "@tanstack/react-router";
import { withSecurity } from "@/lib/mra/security.server";

export const Route = createFileRoute("/api/public/v1/stock/units-of-measure")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        return withSecurity(request, async () => {
          const { handleGetUnitsOfMeasure } = await import("@/lib/mra/handlers.server");
          return handleGetUnitsOfMeasure(request);
        });
      },
    },
  },
});
