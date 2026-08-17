import { createFileRoute } from "@tanstack/react-router";
import { withSecurity } from "@/lib/mra/security.server";

export const Route = createFileRoute("/api/public/v1/ingest/sales")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        return withSecurity(request, async () => {
          const { handleIngestSale } = await import("@/lib/mra/ingest.server");
          return handleIngestSale(request, null);
        });
      },
    },
  },
});