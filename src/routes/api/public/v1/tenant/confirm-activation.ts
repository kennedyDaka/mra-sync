import { createFileRoute } from "@tanstack/react-router";
import { withSecurity } from "@/lib/mra/security.server";

export const Route = createFileRoute("/api/public/v1/tenant/confirm-activation")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        return withSecurity(request, async () => {
          const { handleTerminalActivatedConfirmation } = await import("@/lib/mra/handlers.server");
          return handleTerminalActivatedConfirmation(request);
        });
      },
    },
  },
});
