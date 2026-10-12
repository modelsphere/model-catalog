import type { Model, Variant } from "../types";
import { variantBest } from "./catalog";

// What a list page filters, sorts and summarizes on: one entry per model, or
// per variant. Variant entries take their model's name, family and tags.
export interface Facet {
  name: string;
  displayName: string;
  // How the best-improvement stat names the entry; the name when unset.
  label?: string;
  // A variant's place on its model page.
  rank?: number;
  family: string | null;
  tags: string[];
  // One per variant, so the summary counts variants per engine.
  engines: string[];
  hardware: string[];
  // Every GPU a variant takes, across its nodes; null when it names none.
  gpus?: number | null;
  hasCmp: boolean;
  uplift: number | null;
  deprecated: boolean;
  text: string;
}

function searchText(parts: Array<string | null | undefined | false>): string {
  return parts.filter(Boolean).join(" ").toLowerCase();
}

export function facetsOf(m: Model): Facet {
  const latest = m.versions[0];
  return {
    name: m.name,
    displayName: m.displayName,
    family: m.family,
    tags: m.tags,
    engines: latest.variants.map((v) => v.engine),
    hardware: [...new Set(latest.variants.flatMap((v) => v.hardware))].sort(),
    hasCmp: !!m.comparison,
    uplift: m.comparison ? m.comparison.bestPct : null,
    deprecated: m.deprecated,
    text: searchText([
      m.name,
      m.displayName,
      m.description,
      m.family,
      m.source && m.source.hf,
      ...m.tags,
      ...latest.variants.flatMap((v) => [v.id, v.engine, v.description, ...v.hardware]),
    ]),
  };
}

// uplift is an optimized variant's own best result.
export function variantFacetsOf(m: Model, v: Variant, rank: number): Facet {
  const best = v.isOptimized ? variantBest(m, v.id) : null;
  const req = v.requires || {};
  const image = v.image && v.image.repository ? `${v.image.repository}:${v.image.tag || "latest"}` : null;
  return {
    name: m.name,
    displayName: m.displayName,
    label: `${m.name} · ${v.id}`,
    rank,
    family: m.family,
    tags: m.tags,
    engines: [v.engine],
    hardware: [...new Set(v.hardware)].sort(),
    gpus: req.gpus == null ? null : req.gpus * (req.nodes || 1),
    hasCmp: !!m.comparison,
    uplift: best ? best.upliftPct : null,
    deprecated: m.deprecated,
    text: searchText([
      m.name,
      m.displayName,
      m.family,
      m.source && m.source.hf,
      ...m.tags,
      v.id,
      v.engine,
      v.description,
      image,
      v.chart && v.chart.name,
      ...v.hardware,
    ]),
  };
}

export type Dir = "ascending" | "descending";

// What a list sorts on: a key, in ascending order, and the direction a sort
// starts in. Entries without the key go last whichever way it runs; ties go
// by model, then a model's variants in their model page's order.
interface Sort {
  dir: Dir;
  missing?: (f: Facet) => boolean;
  cmp: (a: Facet, b: Facet) => number;
}

const SORTS: Record<string, Sort> = {
  name: { dir: "ascending", cmp: (a, b) => a.name.localeCompare(b.name) },
  family: { dir: "ascending", missing: (f) => !f.family, cmp: (a, b) => a.family!.localeCompare(b.family!) },
  // Best improvement first.
  uplift: { dir: "descending", missing: (f) => f.uplift == null, cmp: (a, b) => a.uplift! - b.uplift! },
  // Fewest GPUs first.
  gpus: { dir: "ascending", missing: (f) => f.gpus == null, cmp: (a, b) => a.gpus! - b.gpus! },
};

// The direction each sort starts in.
export const sortDir: Record<string, Dir> = Object.fromEntries(Object.entries(SORTS).map(([k, s]) => [k, s.dir]));

export function sorter(key: string, dir: Dir = sortDir[key]): (a: Facet, b: Facet) => number {
  const { missing = () => false, cmp } = SORTS[key];
  const sign = dir === "ascending" ? 1 : -1;
  return (a, b) => {
    const ma = missing(a);
    const mb = missing(b);
    return (
      Number(ma) - Number(mb) ||
      (ma || mb ? 0 : sign * cmp(a, b)) ||
      a.name.localeCompare(b.name) ||
      (a.rank || 0) - (b.rank || 0)
    );
  };
}

export interface Summary {
  models: number;
  deprecated: number;
  variants: number;
  engines: Record<string, number>;
  pairs: number;
  median: number | null;
  worst: { name: string; pct: number } | null;
  best: { name: string; pct: number } | null;
}

// Over either page's entries. Models count once however many variants they
// show; the improvements are each entry's own, so a model's best on one page,
// each tuned variant's on the other.
export function computeSummary(items: Facet[]): Summary {
  const engines: Record<string, number> = {};
  const uplifts: { name: string; pct: number }[] = [];
  const models = new Set<string>();
  const deprecated = new Set<string>();
  const pairs = new Set<string>();
  let variants = 0;
  for (const m of items) {
    models.add(m.name);
    variants += m.engines.length;
    if (m.deprecated) deprecated.add(m.name);
    if (m.hasCmp) pairs.add(m.name);
    if (m.uplift != null) uplifts.push({ name: m.label || m.name, pct: m.uplift });
    for (const e of m.engines) engines[e] = (engines[e] || 0) + 1;
  }
  uplifts.sort((a, b) => a.pct - b.pct);
  const n = uplifts.length;
  const median = n === 0 ? null : n % 2 ? uplifts[(n - 1) / 2].pct : (uplifts[n / 2 - 1].pct + uplifts[n / 2].pct) / 2;
  return {
    models: models.size,
    deprecated: deprecated.size,
    variants,
    engines,
    pairs: pairs.size,
    median,
    worst: n ? uplifts[0] : null,
    best: n ? uplifts[n - 1] : null,
  };
}

export function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of values) counts[v] = (counts[v] || 0) + 1;
  return counts;
}
