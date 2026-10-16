import type { Catalog, Comparison, Index, IndexModel, IndexTuning, IndexVariant, Model, Report, Requires, Tuning, Variant, Workload } from "../types";
import { compareVersions } from "./versions";

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

// Each model's page, as the router and the published site name it.
export function modelPath(m: Model): string {
  return `/models/${encodeURIComponent(m.name)}/index.html`;
}

// A variant's place on its model page.
export const anchorOf = (id: string) => id;

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

// Topologies as a reader knows them: lws by its full name. The URL keeps the
// value itself.
const TOPOLOGY_LABELS: Record<string, string> = { lws: "LeaderWorkerSet", pd: "Prefill/decode-disaggregated" };

export function topologyLabel(topology: string): string {
  return TOPOLOGY_LABELS[topology] || topology;
}

// pd: prefill and decode may each need a different number of GPUs, so
// requires.gpus is no count to show; only the card is.
export const showsGpuCount = (req: Requires) => req.topology !== "pd";

// The topology goes unsaid: every view shows it on its own (see Topology).
function requiresSummary(req: Requires | null): string {
  if (!req) return "";
  let gpus = req.gpus === 0 ? "NO-GPU" : req.gpus != null && showsGpuCount(req) ? `${req.gpus} GPU` + (req.gpus === 1 ? "" : "s") : null;
  // requires.gpus is per pod; a multi-node group needs gpus x nodes in total.
  if (gpus && req.nodes && req.nodes > 1) gpus += ` × ${req.nodes} nodes`;
  const product = Array.isArray(req.gpuProduct) ? req.gpuProduct.join(", ") : null;
  const vendor = req.vendor && req.vendor !== "nvidia" ? req.vendor : null;
  return [gpus, product, vendor].filter(Boolean).join(" · ");
}

// Vendor names as swiss's console shows them.
const VENDOR_NAMES: Record<string, string> = { nvidia: "NVIDIA", ascend: "Ascend", cambricon: "Cambricon", hygon: "Hygon", amd: "AMD" };

const vendorName = (vendor: string) => VENDOR_NAMES[vendor] || vendor;

// Short labels for the hardware filter: NVIDIA-H100-80GB-HBM3 -> H100,
// NVIDIA-RTX-6000D -> RTX-6000D. NVIDIA cards go bare; another vendor's card
// reads "<Vendor> <model>" (Ascend-910B3 -> Ascend 910B3), or stays as is when
// it names the vendor elsewhere. requires.gpus 0 is a CPU-only variant: "NO-GPU".
export function hardwareLabels(req: Requires | null): string[] {
  if (!req) return [];
  if (req.gpus === 0) return ["NO-GPU"];
  const vendor = req.vendor || "nvidia";
  const products = Array.isArray(req.gpuProduct) ? req.gpuProduct : [];
  if (products.length === 0) return [vendor === "nvidia" ? "any GPU" : vendorName(vendor)];
  return products.map((p) => {
    const m = String(p).match(/(?:^|-)([A-Z]{1,2}\d{2,4}[A-Z]?)(?=-|$)/i);
    const card = m ? m[1].toUpperCase() : String(p).replace(/^NVIDIA-/i, "");
    if (vendor === "nvidia") return card;
    const model = card.replace(new RegExp(`^${vendor}-`, "i"), "");
    if (model === card && card.toLowerCase().includes(vendor.toLowerCase())) return card;
    return `${vendorName(vendor)} ${model}`;
  });
}

// Compact hardware line for a variant: "8 × H100", "8 × GPU × 2 nodes", "NO-GPU",
// and for pd the card alone: "RTX-6000D".
export function hardwareShort(req: Requires | null): string {
  if (!req || req.gpus == null) return "";
  if (req.gpus === 0) return "NO-GPU";
  if (!showsGpuCount(req)) return hardwareLabels(req).join(" / ");
  const hasProducts = Array.isArray(req.gpuProduct) && req.gpuProduct.length > 0;
  const vendor = req.vendor && req.vendor !== "nvidia" ? vendorName(req.vendor) : "GPU";
  let s = `${req.gpus} × ${hasProducts ? hardwareLabels(req).join(" / ") : vendor}`;
  if (req.nodes && req.nodes > 1) s += ` × ${req.nodes} nodes`;
  return s;
}

function formatUplift(pct: number): string {
  return `${pct < 0 ? "" : "+"}${(Math.round(pct * 10) / 10).toFixed(1)}%`;
}

// <id>@<version>, as metadata.yaml's tuning names the variant version measured.
function measured(ref: string): [string, string] {
  const at = ref.lastIndexOf("@");
  return at < 0 ? [ref, ""] : [ref.slice(0, at), ref.slice(at + 1)];
}

function tuningEntry(name: string, t: IndexTuning): Tuning {
  const [baselineId, baselineVersion] = measured(t.baseline);
  const [optimizedId, optimizedVersion] = measured(t.optimized);
  const pct = typeof t.uplift === "number" ? t.uplift : null;
  return {
    baselineId,
    baselineVersion,
    optimizedId,
    optimizedVersion,
    upliftPct: pct,
    upliftLabel: pct == null ? null : formatUplift(pct),
    report: t.report ? `models/${name}/${t.report}` : null,
    reportFile: t.report || null,
    workloads: (t.workloads ?? []).map((w) => ({ name: String(w.name), upliftPct: w.uplift, upliftLabel: formatUplift(w.uplift) })),
  };
}

// The pair a model shows: one between two of its variants, preferring one
// measured on the tuned variant's current version, then one whose tuned
// variant is the default. Its one number -- badge, table, sort and summary --
// is its best workload, or the headline when the benchmark recorded none.
function comparisonFor(tuning: Tuning[], variants: Variant[]): Comparison | null {
  const byId = new Map(variants.map((v) => [v.id, v]));
  const fits = tuning.filter((t) => byId.has(t.baselineId) && byId.has(t.optimizedId));
  const t =
    fits.find((x) => byId.get(x.optimizedId)!.version === x.optimizedVersion) || fits.find((x) => byId.get(x.optimizedId)!.default) || fits[0];
  if (!t) return null;
  const best = t.workloads.reduce<Workload | null>((b, w) => (b && b.upliftPct >= w.upliftPct ? b : w), null);
  const bestPct = best ? best.upliftPct : t.upliftPct;
  return { ...t, bestPct, bestLabel: bestPct == null ? null : formatUplift(bestPct), bestWorkload: best ? best.name : null };
}

const deprecation = (d: boolean | string | undefined) => ({ deprecated: !!d, deprecatedReason: typeof d === "string" ? d : null });

function variantOf(index: Index, m: IndexModel, v: IndexVariant, tuning: Tuning[]): Variant {
  const isOptimized = tuning.some((t) => t.optimizedId === v.id);
  const requires = v.requires || null;
  return {
    id: v.id,
    version: v.version,
    releaseDate: v.releaseDate || null,
    path: v.path,
    source: index.repo && v.commit ? `${index.repo}/blob/${v.commit}/${encodePath(v.path)}` : null,
    history: v.history,
    servedName: v.servedName || null,
    engine: v.engine,
    // The first variant when metadata.yaml names none.
    default: v.id === (m.defaultVariant ?? m.variants[0].id),
    description: v.description || null,
    link: v.link && /^https?:\/\//i.test(v.link) ? v.link : null,
    chart: v.chart || null,
    image: v.image || null,
    requires,
    requiresSummary: requiresSummary(requires),
    hardware: hardwareLabels(requires),
    hardwareShort: hardwareShort(requires),
    topology: (requires && requires.topology) || "single-node",
    isOptimized,
    isBaseline: !isOptimized && tuning.some((t) => t.baselineId === v.id),
    ...deprecation(v.deprecated),
  };
}

// The catalog the pages show, from index-v2.json: what they derive from it --
// hardware labels, variant roles, the pair each model shows, source permalinks
// -- worked out once.
export function catalogOf(index: Index): Catalog {
  const models = index.models.map((m): Model => {
    const tuning = m.tuning.map((t) => tuningEntry(m.name, t));
    const variants = m.variants.map((v) => variantOf(index, m, v, tuning));
    return {
      name: m.name,
      displayName: m.displayName || m.name,
      description: m.description || null,
      family: m.family || null,
      tags: m.tags || [],
      ...deprecation(m.deprecated),
      source: m.source || null,
      variants,
      reports: m.reports.map((file): Report => ({ file, path: `models/${m.name}/${file}`, title: file.replace(/\.html$/i, "") })),
      comparison: comparisonFor(tuning, variants),
      tuning,
    };
  });
  return { repo: index.repo || null, count: models.length, models };
}

// The pairs shown on an optimized variant: those of the newest version of it
// measured. That may be older than the variant's current version.
export function tuningFor(m: Model, id: string): Tuning[] {
  const mine = m.tuning.filter((t) => t.optimizedId === id);
  if (!mine.length) return [];
  const newest = mine.map((t) => t.optimizedVersion).reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
  return mine.filter((t) => t.optimizedVersion === newest);
}

// What a version of a variant was benchmarked as, for its revision history:
// the tuned or the baseline side of a recorded pair; null when neither.
export function measuredAs(m: Model, id: string, version: string): string | null {
  const t = m.tuning.find((t) => (t.optimizedId === id && t.optimizedVersion === version) || (t.baselineId === id && t.baselineVersion === version));
  if (!t) return null;
  return t.optimizedId === id
    ? `Measured as the tuned variant${t.upliftLabel ? `: ${t.upliftLabel}` : ""} vs ${t.baselineId}@${t.baselineVersion}`
    : `Measured as the baseline for ${t.optimizedId}@${t.optimizedVersion}`;
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

// An optimized variant's best result, over its pairs and their workloads; null
// for any other variant.
export const variantBest = perObject((m: Model, id: string): Best | null => {
  let best: Best | null = null;
  for (const t of tuningFor(m, id)) {
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
export function orderedVariants(m: Model, variants: Variant[] = m.variants): Variant[] {
  return ordered(m, variants);
}

const ordered = perObject((m: Model, variants: Variant[]): Variant[] => {
  const best = new Map(variants.map((v) => [v.id, (v.isOptimized && variantBest(m, v.id)) || null]));
  const gain = (v: Variant) => best.get(v.id)?.upliftPct ?? -Infinity;
  return variants
    .slice()
    .sort(
      (a, b) =>
        Number(b.isOptimized) - Number(a.isOptimized) || (gain(a) === gain(b) ? 0 : gain(b) - gain(a)) || Number(b.default) - Number(a.default),
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
// measured on an earlier version of its variant says which in its tooltip.
export const reportLinks = perObject((m: Model, label: string): ReportLink[] => {
  const variants = orderedVariants(m);
  const items = m.reports.map((r) => {
    const t = m.tuning.find((x) => x.reportFile === r.file);
    const v = t && m.variants.find((x) => x.id === t.optimizedId);
    const at = v ? variants.findIndex((x) => x.id === v.id) : -1;
    return {
      r,
      id: v ? v.id : null,
      older: t && v && t.optimizedVersion !== v.version ? t.optimizedVersion : null,
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
