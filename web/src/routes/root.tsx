// What every route shares: the catalog, loaded once, and scrolling that
// behaves like page loads -- to the top, or to the variant a link names.
import { useEffect } from "react";
import { isRouteErrorResponse, Link, Outlet, ScrollRestoration, useLocation, useRouteError, type Location } from "react-router";
import { catalogLoaded, loadCatalog } from "@/lib/data";
import { useHost, useTitle } from "@/lib/host";
import { SiteFooter, SiteHeader } from "@/components/site";

export const rootLoader = (base: string) => () => loadCatalog(base);

// index-v2.json changes only with a new build, so no navigation reloads it:
// only a write made from the page, which forgets it (components/edit.tsx).
export const keepCatalog = (base: string) => () => !catalogLoaded(base);

// Scroll positions are kept per page and fragment. By history entry they would
// collide: every page loaded afresh in a tab is the entry "default", so opening
// a link to a variant could restore another page's position instead of landing
// on it. Not by query: the lists keep their filters there without telling the
// router (list-page.tsx).
const byUrl = (l: Location) => l.pathname + l.hash;

export function Root() {
  const { embedded } = useHost();
  return (
    <>
      <Outlet />
      {embedded ? <ScrollInPlace /> : <ScrollRestoration getKey={byUrl} />}
    </>
  );
}

// In another page, a navigation scrolls the element, not the page: to the
// variant a link names, or back to its top when that is out of sight.
// ScrollRestoration would scroll the window, and finds no fragment in a
// shadow root.
function ScrollInPlace() {
  const { root } = useHost();
  const { pathname, hash } = useLocation();
  useEffect(() => {
    const target = hash && root.querySelector(`#${CSS.escape(decodeURIComponent(hash.slice(1)))}`);
    if (target) target.scrollIntoView();
    else if (root.getBoundingClientRect().top < 0) root.scrollIntoView();
  }, [pathname, hash, root]);
  return null;
}

// A page that is not in the catalog, or a catalog that would not load.
export function NotFound({ message = "No such page in this catalog." }: { message?: string }) {
  useTitle("Not found · Model Catalog");
  return (
    <>
      <SiteHeader eyebrow={<Link to="/">model-catalog</Link>} title="Not found" />
      <main className="wrap">
        <p className="rounded-2xl border border-dashed border-input px-4 py-12 text-center text-muted-foreground">
          {message} <Link to="/">All recipes</Link>
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
