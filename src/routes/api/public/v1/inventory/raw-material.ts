import { createFileRoute } from "@tanstack/react-router";
import { withSecurity } from "@/lib/mra/security.server";

export const Route = createFileRoute("/api/public/v1/inventory/raw-material")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        return withSecurity(request, async () => {
          const { handleGetRawMaterial } = await import("@/lib/mra/handlers.server");
          return handleGetRawMaterial(request);
        });
      },
    },
  },
});
