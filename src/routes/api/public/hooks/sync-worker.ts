import { createFileRoute } from "@tanstack/react-router";

/** Catch-up pipeline daemon. Invoked on a schedule; drains the FIFO sync queue. */
export const Route = createFileRoute("/api/public/hooks/sync-worker")({
  server: {
    handlers: {
      POST: async () => {
        const { handleQueueWorker } = await import("@/lib/mra/handlers.server");
        return handleQueueWorker();
      },
    },
  },
});
