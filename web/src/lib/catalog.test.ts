import { describe, expect, test } from "vitest";
import type { Index, Model, Tuning, Variant } from "../types";
import { catalogOf, hardwareLabels, hardwareShort, measuredAs, orderedVariants, reportLinks, tuningFor, variantBest } from "./catalog";
import { computeSummary, sorter, variantFacetsOf, type Facet } from "./facets";
import { compareVersions } from "./versions";

const variant = (id: string, over: Partial<Variant> = {}): Variant => ({
  id,
  version: "1.0.1",
  releaseDate: null,
  path: `models/m/${id}.yaml`,
  source: null,
  history: `models/m/${id}.history.json`,
  servedName: null,
  engine: "sglang",
  default: false,
  description: null,
  link: null,
  chart: null,
  image: null,
  requires: { gpus: 8 },
  requiresSummary: "",
  hardware: ["H100"],
  hardwareShort: "8 × H100",
  topology: "single-node",
  isBaseline: false,
  isOptimized: false,
  deprecated: false,
  deprecatedReason: null,
  ...over,
});

// optimizedId measured at version, against base at the same version.
const pair = (version: string, optimizedId: string, pcts: number[], over: Partial<Tuning> = {}): Tuning => ({
  baselineId: "base",
  baselineVersion: version,
  optimizedId,
  optimizedVersion: version,
  upliftPct: pcts[0],
  upliftLabel: `+${pcts[0]}%`,
  report: null,
  reportFile: null,
  workloads: pcts.map((p, i) => ({ name: `w${i}`, upliftPct: p, upliftLabel: `+${p}%` })),
  ...over,
});

const model = (variants: Variant[], tuning: Tuning[], over: Partial<Model> = {}): Model => ({
  name: "m",
  displayName: "M",
  description: null,
  family: null,
  tags: [],
  deprecated: false,
  deprecatedReason: null,
  source: null,
  variants,
  reports: [],
  comparison: null,
  tuning,
  ...over,
});

test("versions order by semver precedence", () => {
  const sorted = ["1.0.0", "1.0.0-rc.10", "1.0.0-rc.2", "1.0.0-alpha", "0.9.9", "1.0.0-alpha.1"].sort(compareVersions);
  expect(sorted).toEqual(["0.9.9", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-rc.2", "1.0.0-rc.10", "1.0.0"]);
});

describe("tuning", () => {
  const m = model(
    [variant("base", { isBaseline: true }), variant("fast", { isOptimized: true }), variant("faster", { isOptimized: true, default: true })],
    [pair("1.0.0", "fast", [10, 30]), pair("0.9.0", "fast", [99]), pair("1.0.1", "faster", [40])],
  );

  test("a tuned variant shows the pairs of its newest version measured", () => {
    expect(tuningFor(m, "fast").map((t) => t.optimizedVersion)).toEqual(["1.0.0"]);
    expect(tuningFor(m, "faster").map((t) => t.optimizedVersion)).toEqual(["1.0.1"]);
    expect(tuningFor(m, "base")).toEqual([]);
  });

  test("a variant's best is its best workload, out of how many", () => {
    expect(variantBest(m, "fast")).toMatchObject({ name: "w1", upliftPct: 30, of: 2 });
    expect(variantBest(m, "base")).toBeNull();
  });

  test("optimized variants come first, the biggest improvement first", () => {
    expect(orderedVariants(m).map((v) => v.id)).toEqual(["faster", "fast", "base"]);
  });

  test("a revision says which side of a pair it was measured as, if any", () => {
    expect(measuredAs(m, "fast", "1.0.0")).toBe("Measured as the tuned variant: +10% vs base@1.0.0");
    expect(measuredAs(m, "base", "1.0.1")).toBe("Measured as the baseline for faster@1.0.1");
    expect(measuredAs(m, "fast", "1.0.1")).toBeNull();
  });
});

test("one report is labeled as asked; several, by the GPUs each measured", () => {
  const reports = [
    { file: "a.html", path: "models/m/a.html", title: "a" },
    { file: "b.html", path: "models/m/b.html", title: "b" },
  ];
  const variants = [variant("h100", { isOptimized: true }), variant("b300", { isOptimized: true, hardware: ["B300"] })];
  const tuning = [pair("1.0.1", "h100", [5], { reportFile: "a.html" }), pair("1.0.0", "b300", [9], { reportFile: "b.html" })];
  expect(reportLinks(model(variants, tuning, { reports: reports.slice(0, 1) }), "Perf report").map((r) => r.text)).toEqual(["Perf report"]);
  expect(reportLinks(model(variants, tuning, { reports }), "Perf report").map((r) => [r.text, r.title])).toEqual([
    ["B300 perf report", "b.html, measured on v1.0.0"],
    ["H100 perf report", "a.html"],
  ]);
});

describe("index-v2.json", () => {
  const sha = "a".repeat(40);
  const file = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    version: "1.0.2",
    releaseDate: "2026-10-12",
    commit: sha,
    path: `models/m/${id}.yaml`,
    digest: `sha256:${"0".repeat(64)}`,
    history: `models/m/${id}.history.json`,
    engine: "sglang",
    chart: { name: "sglang", version: ">=0.8.0" },
    requires: { gpus: 8, gpuProduct: ["NVIDIA-H100-80GB-HBM3"] },
    ...over,
  });
  const index = (over: Record<string, unknown> = {}): Index => ({
    apiVersion: "catalog.swiss/v2",
    repo: "https://github.com/o/c",
    count: 1,
    models: [
      {
        name: "m",
        reports: ["m-h100-report.html"],
        tuning: [
          { baseline: "base@1.0.0", optimized: "fast@1.0.0", uplift: 5 },
          { baseline: "base@1.0.2", optimized: "fast@1.0.2", uplift: 12, workloads: [{ name: "8k + 1k", uplift: 20 }], report: "m-h100-report.html" },
        ],
        variants: [
          file("base"),
          file("fast", { servedName: "m-served", deprecated: "superseded" }),
          file("draft", { commit: undefined, releaseDate: undefined, requires: { gpus: 2, nodes: 2, topology: "lws" } }),
        ],
        ...over,
      },
    ],
  });

  test("each variant's roles, default, source pinned to its commit, and release", () => {
    const [m] = catalogOf(index()).models;
    expect(m.variants.map((v) => [v.id, v.default, v.isOptimized, v.isBaseline])).toEqual([
      ["base", true, false, true],
      ["fast", false, true, false],
      ["draft", false, false, false],
    ]);
    expect(m.variants[0]).toMatchObject({
      source: `https://github.com/o/c/blob/${sha}/models/m/base.yaml`,
      releaseDate: "2026-10-12",
      hardwareShort: "8 × H100",
    });
    expect(m.variants[1]).toMatchObject({ servedName: "m-served", deprecated: true, deprecatedReason: "superseded" });
    // Uncommitted: nothing to pin, no release yet.
    expect(m.variants[2]).toMatchObject({ source: null, releaseDate: null, hardware: ["any GPU"], hardwareShort: "2 × GPU × 2 nodes" });
    expect(catalogOf(index({ defaultVariant: "fast" })).models[0].variants.find((v) => v.default)?.id).toBe("fast");
  });

  test("tuning names the variant versions measured; the model shows the pair measured on the current one", () => {
    const [m] = catalogOf(index()).models;
    expect(m.tuning.map((t) => [t.optimizedId, t.optimizedVersion, t.baselineId, t.baselineVersion])).toEqual([
      ["fast", "1.0.0", "base", "1.0.0"],
      ["fast", "1.0.2", "base", "1.0.2"],
    ]);
    expect(m.comparison).toMatchObject({ optimizedVersion: "1.0.2", bestPct: 20, bestWorkload: "8k + 1k", report: "models/m/m-h100-report.html" });
    expect(m.reports).toEqual([{ file: "m-h100-report.html", path: "models/m/m-h100-report.html", title: "m-h100-report" }]);
  });

  test("hardware labels: NVIDIA cards bare, another vendor's named", () => {
    expect(hardwareLabels({ gpus: 8, gpuProduct: ["NVIDIA-H100-80GB-HBM3", "NVIDIA-RTX-6000D"] })).toEqual(["H100", "RTX-6000D"]);
    expect(hardwareLabels({ gpus: 1, vendor: "ascend", gpuProduct: ["Ascend-910B3"] })).toEqual(["Ascend 910B3"]);
    expect(hardwareShort({ gpus: 1, vendor: "ascend" })).toBe("1 × Ascend");
  });
});

describe("facets", () => {
  const f = (over: Partial<Facet>): Facet => ({
    name: "m",
    displayName: "M",
    family: null,
    tags: [],
    engines: ["sglang"],
    hardware: [],
    topology: [],
    hasCmp: false,
    uplift: null,
    deprecated: false,
    text: "",
    ...over,
  });

  test("the default order: improvement, then model, then the model page's order", () => {
    const items = [f({ name: "b", rank: 1 }), f({ name: "a", uplift: 5 }), f({ name: "b", rank: 0 }), f({ name: "c", uplift: 50 })];
    expect(items.sort(sorter("uplift")).map((x) => `${x.name}${x.rank ?? ""}`)).toEqual(["c", "a", "b0", "b1"]);
  });

  test("reversed, the key runs the other way; entries without it stay last, ties keep their order", () => {
    const items = [f({ name: "b", rank: 1 }), f({ name: "a", uplift: 5 }), f({ name: "b", rank: 0 }), f({ name: "c", uplift: 50 })];
    expect(items.sort(sorter("uplift", "ascending")).map((x) => `${x.name}${x.rank ?? ""}`)).toEqual(["a", "c", "b0", "b1"]);
    const named = [f({ name: "a", rank: 1 }), f({ name: "b" }), f({ name: "a", rank: 0 })];
    expect(named.sort(sorter("name", "descending")).map((x) => `${x.name}${x.rank ?? ""}`)).toEqual(["b", "a0", "a1"]);
  });

  test("fewest GPUs first, a variant naming none last", () => {
    const items = [f({ name: "x", gpus: null }), f({ name: "y", gpus: 16 }), f({ name: "z", gpus: 4 })];
    expect(items.sort(sorter("gpus")).map((x) => x.name)).toEqual(["z", "y", "x"]);
    expect(items.sort(sorter("gpus", "descending")).map((x) => x.name)).toEqual(["y", "z", "x"]);
  });

  test("a model counts once however many of its variants show", () => {
    const s = computeSummary([
      f({ name: "a", hasCmp: true, uplift: 10, label: "a · fast" }),
      f({ name: "a", hasCmp: true }),
      f({ name: "b", deprecated: true }),
    ]);
    expect(s).toMatchObject({ models: 2, variants: 3, pairs: 1, deprecated: 1, median: 10, best: { name: "a · fast", pct: 10 } });
  });

  test("a variant's facets take its own GPUs, nodes and image", () => {
    const v = variant("fast", { isOptimized: true, requires: { gpus: 8, nodes: 2 }, image: { repository: "org/sglang", tag: "v1" } });
    const facet = variantFacetsOf(model([v], [pair("1.0.1", "fast", [12])]), v, 0);
    expect(facet).toMatchObject({ gpus: 16, uplift: 12, label: "m · fast", engines: ["sglang"] });
    expect(facet.text).toContain("org/sglang:v1");
  });
});
