import { createFileRoute } from "@tanstack/react-router";
import { withSecurity } from "@/lib/mra/security.server";

export const Route = createFileRoute("/api/public/v1/tenant/activate")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        return withSecurity(request, async () => {
          const { handleActivate } = await import("@/lib/mra/handlers.server");
          return handleActivate(request);
        });
      },
    },
  },
});
