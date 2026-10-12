import type { Catalog, Index, Variant } from "@/types";
import { catalogOf, encodePath } from "./catalog";

const ROOT = import.meta.env.BASE_URL;

// index-v2.json, fetched once for the whole visit: it changes only with a
// new build.
let catalog: Promise<Catalog> | null = null;

export function loadCatalog(): Promise<Catalog> {
  catalog ??= fetch(`${ROOT}index-v2.json`).then(async (res) => {
    if (!res.ok) {
      catalog = null;
      throw new Error(`index-v2.json: ${res.status}`);
    }
    return catalogOf((await res.json()) as Index);
  });
  return catalog;
}

// A variant's published file, its configuration as a model page shows it;
// null when it cannot be had.
export async function loadVariantText(v: Variant): Promise<string | null> {
  const res = await fetch(ROOT + encodePath(v.path));
  return res.ok ? res.text() : null;
}
