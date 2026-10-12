// What every route shares: the catalog, loaded once, and scrolling that
// behaves like page loads -- to the top, or to the variant a link names.
import { useEffect } from "react";
import { isRouteErrorResponse, Link, Outlet, ScrollRestoration, useRouteError, type Location } from "react-router";
import { loadCatalog } from "@/lib/data";
import { SiteFooter, SiteHeader } from "@/components/site";

export const rootLoader = () => loadCatalog();

// index-v2.json changes only with a new build, so no navigation reloads it.
export const keepCatalog = () => false;

// Scroll positions are kept per page and fragment. By history entry they would
// collide: every page loaded afresh in a tab is the entry "default", so opening
// a link to a variant could restore another page's position instead of landing
// on it. Not by query: the lists keep their filters there without telling the
// router (list-page.tsx).
const byUrl = (l: Location) => l.pathname + l.hash;

export function Root() {
  return (
    <>
      <Outlet />
      <ScrollRestoration getKey={byUrl} />
    </>
  );
}

// A page that is not in the catalog, or a catalog that would not load.
export function NotFound({ message = "No such page in this catalog." }: { message?: string }) {
  useEffect(() => {
    document.title = "Not found · Model Catalog";
  }, []);
  return (
    <>
      <SiteHeader eyebrow={<Link to="/">model-catalog</Link>} title="Not found" />
      <main className="wrap">
        <p className="rounded-2xl border border-dashed border-input px-4 py-12 text-center text-muted-foreground">
          {message} <Link to="/models.html">All models</Link>
        </p>
      </main>
      <SiteFooter>
        Generated from <code>models/</code> by <code>npm run build:site</code>.
      </SiteFooter>
    </>
  );
}

export function RouteError() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error) ? String(error.data) : `Could not load the catalog: ${(error as Error).message}`;
  return <NotFound message={message} />;
}
