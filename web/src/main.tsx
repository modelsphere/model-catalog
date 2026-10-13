// The site, one page: the deployment recipes, the models and each model's
// page are routes. The recipes are the front page; variants.html, where they
// were before, still shows them, so old links keep working.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { keepCatalog, NotFound, Root, rootLoader, RouteError } from "@/routes/root";
import { ModelsRoute } from "@/routes/models";
import { VariantsRoute } from "@/routes/variants";
import { keepModel, modelLoader, ModelRoute } from "@/routes/model";
import "@fontsource-variable/fraunces/opsz.css";
import "@fontsource-variable/fraunces/opsz-italic.css";
import "./index.css";

const model = { loader: modelLoader, shouldRevalidate: keepModel, Component: ModelRoute };

const router = createBrowserRouter(
  [
    {
      id: "root",
      loader: rootLoader,
      shouldRevalidate: keepCatalog,
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
  ],
  // GitHub Pages serves the site under /model-catalog/. With the slash, the
  // front page is /model-catalog/, not /model-catalog: the page itself, not
  // a path the server has to redirect.
  { basename: import.meta.env.BASE_URL },
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
