import { createFileRoute } from "@tanstack/react-router";
import { withSecurity } from "@/lib/mra/security.server";

export const Route = createFileRoute("/api/public/v1/recipes")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        return withSecurity(request, async () => {
          const { handleListRecipes } = await import("@/lib/mra/recipe-handlers.server");
          return handleListRecipes(request);
        });
      },
      POST: async ({ request }) => {
        return withSecurity(request, async () => {
          const { handleCreateRecipe } = await import("@/lib/mra/recipe-handlers.server");
          return handleCreateRecipe(request);
        });
      },
      PUT: async ({ request }) => {
        return withSecurity(request, async () => {
          const { handleUpdateRecipe } = await import("@/lib/mra/recipe-handlers.server");
          return handleUpdateRecipe(request);
        });
      },
      DELETE: async ({ request }) => {
        return withSecurity(request, async () => {
          const { handleDeleteRecipe } = await import("@/lib/mra/recipe-handlers.server");
          return handleDeleteRecipe(request);
        });
      },
    },
  },
});
