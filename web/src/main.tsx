// The site, one page: the catalog's routes (routes/index.ts) at the site's
// own address.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { catalogRoutes } from "@/routes";
import "@fontsource-variable/fraunces/opsz.css";
import "@fontsource-variable/fraunces/opsz-italic.css";
import "./index.css";

const router = createBrowserRouter(
  catalogRoutes(import.meta.env.BASE_URL),
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
