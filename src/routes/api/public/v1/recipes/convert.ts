import { createFileRoute } from "@tanstack/react-router";
import { withSecurity } from "@/lib/mra/security.server";

export const Route = createFileRoute("/api/public/v1/recipes/convert")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        return withSecurity(request, async () => {
          const { handleConvertRecipe } = await import("@/lib/mra/recipe-handlers.server");
          return handleConvertRecipe(request);
        });
      },
    },
  },
});
