import { createFileRoute } from "@tanstack/react-router";
import { withSecurity } from "@/lib/mra/security.server";

export const Route = createFileRoute("/api/public/v1/utilities/blocking-message")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        return withSecurity(request, async () => {
          const { handleTerminalBlockingMessage } = await import("@/lib/mra/handlers.server");
          return handleTerminalBlockingMessage(request);
        });
      },
    },
  },
});
