import { createFileRoute } from "@tanstack/react-router";
import { withSecurity } from "@/lib/mra/security.server";

export const Route = createFileRoute("/api/public/v1/sales/last-submitted-online")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        return withSecurity(request, async () => {
          const { handleLastSubmittedOnline } = await import("@/lib/mra/handlers.server");
          return handleLastSubmittedOnline(request);
        });
      },
    },
  },
});
