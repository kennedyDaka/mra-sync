import { createFileRoute } from "@tanstack/react-router";
import { withSecurity } from "@/lib/mra/security.server";

export const Route = createFileRoute("/api/public/v1/ingest/$source/inventory")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        return withSecurity(request, async () => {
          const { handleIngestInventory } = await import("@/lib/mra/ingest.server");
          return handleIngestInventory(request, params.source);
        });
      },
    },
  },
});