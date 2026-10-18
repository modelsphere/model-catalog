import type { Catalog, History, Index, Variant } from "@/types";
import { catalogOf, encodePath } from "./catalog";

// Every fetch is from a catalog's root (Host.base): the site's own, or the one
// a <model-catalog> element names. One page may show several.

// index-v2.json, fetched once for the whole visit: it changes only with a
// new build, or a write made from this page (forgetCatalog).
const catalogs = new Map<string, Promise<Catalog>>();

// Whether the catalog at base is loaded: after forgetCatalog, it is not, and
// the routes load it again (routes/root.tsx).
export const catalogLoaded = (base: string) => catalogs.has(base);

export function loadCatalog(base: string): Promise<Catalog> {
  let catalog = catalogs.get(base);
  if (!catalog) {
    catalog = fetch(`${base}index-v2.json`).then(async (res) => {
      if (!res.ok) {
        catalogs.delete(base);
        throw new Error(`index-v2.json: ${res.status}`);
      }
      return catalogOf((await res.json()) as Index);
    });
    catalogs.set(base, catalog);
  }
  return catalog;
}

// A variant's published file, its configuration as a model page shows it;
// null when it cannot be had.
export async function loadVariantText(base: string, v: Variant): Promise<string | null> {
  const res = await fetch(base + encodePath(v.path));
  return res.ok ? res.text() : null;
}

// A variant's history.json, fetched once per visit, when first asked for.
const histories = new Map<string, Promise<History>>();

export function loadHistory(base: string, v: Variant): Promise<History> {
  const url = base + encodePath(v.history);
  let h = histories.get(url);
  if (!h) {
    h = fetch(url).then((res) => {
      if (!res.ok) {
        histories.delete(url);
        throw new Error(`${v.history}: ${res.status}`);
      }
      return res.json();
    });
    histories.set(url, h);
  }
  return h;
}

// After a write: the catalog and its histories are fetched again.
export function forgetCatalog(base: string) {
  catalogs.delete(base);
  for (const url of histories.keys()) if (url.startsWith(base)) histories.delete(url);
}
