// The site's routes, for a catalog at base: the deployment recipes, the
// models and each model's page. The recipes are the front page;
// variants.html, where they were before, still shows them, so old links keep
// working. main.tsx serves them as the site, element.tsx inside another page.
import type { RouteObject } from "react-router";
import { keepCatalog, NotFound, Root, rootLoader, RouteError } from "@/routes/root";
import { ModelsRoute } from "@/routes/models";
import { VariantsRoute } from "@/routes/variants";
import { keepModel, modelLoader, ModelRoute } from "@/routes/model";

export function catalogRoutes(base: string): RouteObject[] {
  const model = { loader: modelLoader(base), shouldRevalidate: keepModel(base), Component: ModelRoute };
  return [
    {
      id: "root",
      loader: rootLoader(base),
      shouldRevalidate: keepCatalog(base),
      Component: Root,
      ErrorBoundary: RouteError,
      // Until index-v2.json is in, the page stays as index.html left it.
      HydrateFallback: () => null,
      children: [
        { index: true, Component: VariantsRoute },
        { path: "index.html", Component: VariantsRoute },
        { path: "variants.html", Component: VariantsRoute },
        { path: "models.html", Component: ModelsRoute },
        { path: "models/:dir", ...model },
        { path: "models/:dir/index.html", ...model },
        { path: "*", Component: NotFound },
      ],
    },
  ];
}
