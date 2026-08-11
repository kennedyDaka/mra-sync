import { createFileRoute } from "@tanstack/react-router";

/** Refreshes cached MRA configuration (tax brackets, version rules) per terminal. */
export const Route = createFileRoute("/api/public/hooks/config-sync")({
  server: {
    handlers: {
      POST: async () => {
        const { handleConfigSync } = await import("@/lib/mra/handlers.server");
        return handleConfigSync();
      },
    },
  },
});
