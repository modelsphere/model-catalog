// index-v2.json, as the catalog server (server/index.js) serves it and
// schema/index-v2.schema.json describes it; and the catalog the pages show,
// derived from it (lib/catalog.ts).

export interface Requires {
  gpus?: number;
  nodes?: number;
  vendor?: string;
  gpuProduct?: string[];
  topology?: string;
}

export interface Chart {
  name?: string;
  version?: string;
}

export interface Image {
  repository?: string;
  tag?: string;
  digest?: string;
}

export interface IndexVariant {
  id: string;
  version: string;
  releaseDate?: string;
  commit?: string;
  path: string;
  digest: string;
  history: string;
  servedName?: string;
  engine: string;
  description?: string;
  link?: string;
  chart: Chart;
  image?: Image;
  requires: Requires;
  deprecated?: boolean | string;
  replaces?: string;
}

export interface IndexTuning {
  // <id>@<version>: the variant version measured.
  baseline: string;
  optimized: string;
  uplift?: number;
  workloads?: { name: string; uplift: number }[];
  report?: string;
}

export interface IndexModel {
  name: string;
  displayName?: string;
  description?: string;
  family?: string;
  series?: string;
  tags?: string[];
  deprecated?: boolean | string;
  source?: { hf?: string; revision?: string; sizeGiB?: number };
  quantization?: string;
  defaultVariant?: string;
  reports: string[];
  tuning: IndexTuning[];
  variants: IndexVariant[];
}

export interface Index {
  apiVersion: string;
  site?: string;
  repo?: string;
  raw?: string;
  commit?: string;
  count: number;
  models: IndexModel[];
}

// models/<name>/<id>.history.json: a variant file's revisions, from git.
export interface Revision {
  version: string;
  // The commit's date; absent, as the commit is, for an uncommitted edit.
  releaseDate?: string;
  commit?: string;
  digest: string;
  subject: string;
}

export interface History {
  model: string;
  id: string;
  path: string;
  // Newest first.
  revisions: Revision[];
  deleted?: { commit: string; subject: string };
}

export interface Workload {
  name: string;
  upliftPct: number;
  upliftLabel: string;
}

// A recorded optimized-vs-baseline pair, each side the variant version measured.
export interface Tuning {
  baselineId: string;
  baselineVersion: string;
  optimizedId: string;
  optimizedVersion: string;
  upliftPct: number | null;
  upliftLabel: string | null;
  report: string | null;
  reportFile: string | null;
  workloads: Workload[];
}

// The pair a model shows, with its best workload.
export interface Comparison extends Tuning {
  bestPct: number | null;
  bestLabel: string | null;
  bestWorkload: string | null;
}

export interface Report {
  file: string;
  path: string;
  title: string;
}

export interface Variant {
  id: string;
  version: string;
  // When this version was released, from git; null while uncommitted.
  releaseDate: string | null;
  // The variant file, from the site's root.
  path: string;
  // sha256 of its bytes: what a write to it names it by (lib/edit.ts).
  digest: string;
  // The variant file on GitHub, pinned to its commit.
  source: string | null;
  // Its history.json, from the site's root.
  history: string;
  servedName: string | null;
  engine: string;
  default: boolean;
  description: string | null;
  link: string | null;
  chart: Chart | null;
  image: Image | null;
  requires: Requires | null;
  requiresSummary: string;
  hardware: string[];
  hardwareShort: string;
  // requires.topology: single-node when unset.
  topology: string;
  isBaseline: boolean;
  isOptimized: boolean;
  deprecated: boolean;
  deprecatedReason: string | null;
}

export interface Model {
  name: string;
  displayName: string;
  description: string | null;
  family: string | null;
  tags: string[];
  deprecated: boolean;
  deprecatedReason: string | null;
  source: { hf?: string; revision?: string } | null;
  // In file order: index-v2.json's.
  variants: Variant[];
  reports: Report[];
  comparison: Comparison | null;
  tuning: Tuning[];
}

export interface Catalog {
  // The GitHub repository the variant files live in.
  repo: string | null;
  count: number;
  models: Model[];
}
