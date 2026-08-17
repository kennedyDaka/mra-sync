import { createFileRoute } from "@tanstack/react-router";
import { withSecurity } from "@/lib/mra/security.server";

export const Route = createFileRoute("/api/public/v1/recipe")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        return withSecurity(request, async () => {
          const { handleGetRecipe } = await import("@/lib/mra/recipe-handlers.server");
          return handleGetRecipe(request);
        });
      },
    },
  },
});