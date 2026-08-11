import { createFileRoute } from "@tanstack/react-router";
import { withSecurity } from "@/lib/mra/security.server";

export const Route = createFileRoute("/api/public/v1/ping")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        return withSecurity(request, async () => {
          const { handlePing } = await import("@/lib/mra/handlers.server");
          return handlePing(request);
        });
      },
    },
  },
});
