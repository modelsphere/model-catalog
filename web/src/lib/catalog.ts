import type { Catalog, Model, Report, Tuning, Variant, Version, Workload } from "../types";
import { compareVersions } from "./versions";

// catalog.json, from the site's root as seen from the page (a model page sits
// two directories down).
export async function fetchCatalog(root: string): Promise<Catalog> {
  const res = await fetch(`${root}catalog.json`);
  if (!res.ok) throw new Error(`catalog.json: ${res.status}`);
  return res.json();
}

// What an uplift number means, for tooltips. Workload names are the report's:
// input + output tokens per request.
export const UPLIFT_HELP =
  "Throughput of the tuned recipe over its baseline, from the tuning benchmark. " +
  "Workloads are input + output tokens per request, e.g. 50k + 1.5k.";

// The perf reports' own English names for the benchmark's workloads; the
// token shape moves to the row's tooltip.
export const WORKLOAD_NAMES: Record<string, string> = { "50k + 1.5k": "Agent long-context", "8k + 1k": "Document QA" };

// The site is in English; an AutoTune report picks its language from the URL
// fragment, falling back to its own default when it has no such language.
export const REPORT_LANG = "#en";

export function encodePath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}

// The version a deploy naming none gets: what the model page and the variants
// page show.
export function latestVersion(m: Model): Version {
  return m.versions.find((v) => v.version === m.latest)!;
}

// Each model's page, as the router and the published site name it.
export function modelPath(m: Model): string {
  return `/models/${encodeURIComponent(m.dir)}/index.html`;
}

export const anchorOf = (version: string, id: string) => `v${version}-${id}`;

// Whether the id adds nothing to the display name: the name lowercased, with
// spaces and slashes as dashes (DeepSeek-V4-Flash -> deepseek-v4-flash). The
// lists then show the id only as a tooltip.
export function idIsDisplayName(m: Model): boolean {
  const slug = m.displayName
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === m.name;
}

// The pairs shown on an optimized variant in a version: those measured on that
// version, else -- a tuned variant carried forward unchanged -- those of the
// newest earlier version that measured it.
export function tuningFor(m: Model, version: string, id: string): Tuning[] {
  const mine = m.tuning.filter((t) => t.optimizedId === id);
  const same = mine.filter((t) => t.version === String(version));
  if (same.length) return same;
  const earlier = mine
    .filter((t) => compareVersions(t.version, version) < 0)
    .sort((a, b) => compareVersions(b.version, a.version));
  return earlier.length ? earlier.filter((t) => t.version === earlier[0].version) : [];
}

// A result per model (or per its variants list) and argument, computed once:
// the catalog loads once per visit and its objects never change.
function perObject<K extends object, A, R>(f: (k: K, a: A) => R): (k: K, a: A) => R {
  const cache = new WeakMap<K, Map<A, R>>();
  return (k, a) => {
    let byArg = cache.get(k);
    if (!byArg) cache.set(k, (byArg = new Map()));
    if (!byArg.has(a)) byArg.set(a, f(k, a));
    return byArg.get(a)!;
  };
}

export interface Best {
  name: string | null;
  upliftPct: number;
  upliftLabel: string;
  t: Tuning;
  // How many results it is the best of.
  of: number;
}

// An optimized variant's best result in the latest version, over its pairs and
// their workloads; null for any other variant.
export const variantBest = perObject((m: Model, id: string): Best | null => {
  let best: Best | null = null;
  for (const t of tuningFor(m, m.latest, id)) {
    const rows: Array<Workload | { name: null; upliftPct: number | null; upliftLabel: string | null }> = t.workloads.length
      ? t.workloads
      : [{ name: null, upliftPct: t.upliftPct, upliftLabel: t.upliftLabel }];
    for (const w of rows) {
      if (w.upliftPct != null && (!best || w.upliftPct > best.upliftPct)) {
        best = { name: w.name, upliftPct: w.upliftPct, upliftLabel: w.upliftLabel!, t, of: rows.length };
      }
    }
  }
  return best;
});

// Optimized variants first, the biggest improvement first, then the rest.
// Ties go to the default, then file order (sort is stable). Every list and
// the model page show variants in this one order.
export function orderedVariants(m: Model, variants: Variant[] = m.versions[0].variants): Variant[] {
  return ordered(m, variants);
}

const ordered = perObject((m: Model, variants: Variant[]): Variant[] => {
  const best = new Map(variants.map((v) => [v.id, (v.isOptimized && variantBest(m, v.id)) || null]));
  const gain = (v: Variant) => best.get(v.id)?.upliftPct ?? -Infinity;
  return variants
    .slice()
    .sort(
      (a, b) =>
        Number(b.isOptimized) - Number(a.isOptimized) ||
        (gain(a) === gain(b) ? 0 : gain(b) - gain(a)) ||
        Number(b.default) - Number(a.default)
    );
});

export interface ReportLink {
  r: Report;
  // The tuned variant it measured.
  id: string | null;
  title: string;
  text: string;
}

// A model's reports in its variants' order, each with its link text: the
// label alone for one report; for several, the GPUs of the variant each
// measured, or its file name when those do not tell them apart. A report
// measured on an earlier version than the latest says which in its tooltip.
export const reportLinks = perObject((m: Model, label: string): ReportLink[] => {
  const variants = orderedVariants(m);
  const all = m.versions.flatMap((ver) => ver.variants);
  const items = m.reports.map((r) => {
    const t = m.tuning.find((x) => x.reportFile === r.file);
    const v = t && all.find((x) => x.id === t.optimizedId);
    const at = v ? variants.findIndex((x) => x.id === v.id) : -1;
    return {
      r,
      id: v ? v.id : null,
      older: t && t.version !== m.latest ? t.version : null,
      hw: v && v.hardware.length ? v.hardware.join(" / ") : null,
      at: at < 0 ? Infinity : at,
    };
  });
  const distinct = items.every((x) => x.hw && items.filter((y) => y.hw === x.hw).length === 1);
  return items
    .sort((a, b) => a.at - b.at)
    .map(({ r, id, older, hw }) => ({
      r,
      id,
      title: older ? `${r.file}, measured on v${older}` : r.file,
      text: items.length < 2 ? label : distinct ? `${hw} ${label.toLowerCase()}` : r.title,
    }));
});

// A variant's configuration: its own lines of the published version file,
// dedented, with its "- " marker gone.
export function variantYaml(text: string, lines: NonNullable<Variant["lines"]>): string {
  const own = text.split("\n").slice(lines.from - 1, lines.to);
  own[0] = " ".repeat(lines.indent) + own[0].slice(lines.indent);
  return own
    .map((l) => l.slice(lines.indent))
    .join("\n")
    .replace(/\s+$/, "");
}
