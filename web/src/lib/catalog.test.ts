import { describe, expect, test } from "vitest";
import type { Model, Tuning, Variant } from "../types";
import { orderedVariants, reportLinks, tuningFor, variantBest, variantYaml } from "./catalog";
import { computeSummary, sorter, variantFacetsOf, type Facet } from "./facets";
import { compareVersions } from "./versions";

const variant = (id: string, over: Partial<Variant> = {}): Variant => ({
  id,
  engine: "sglang",
  default: false,
  description: null,
  link: null,
  source: null,
  chart: null,
  image: null,
  lines: null,
  requires: { gpus: 8 },
  requiresSummary: "",
  hardware: ["H100"],
  hardwareShort: "8 × H100",
  isBaseline: false,
  isOptimized: false,
  ...over,
});

const pair = (version: string, optimizedId: string, pcts: number[], over: Partial<Tuning> = {}): Tuning => ({
  version,
  baselineId: "base",
  optimizedId,
  upliftPct: pcts[0],
  upliftLabel: `+${pcts[0]}%`,
  report: null,
  reportFile: null,
  workloads: pcts.map((p, i) => ({ name: `w${i}`, upliftPct: p, upliftLabel: `+${p}%` })),
  ...over,
});

const model = (variants: Variant[], tuning: Tuning[], over: Partial<Model> = {}): Model => ({
  name: "m",
  dir: "m",
  displayName: "M",
  description: null,
  family: null,
  tags: [],
  deprecated: false,
  deprecatedReason: null,
  source: null,
  latest: "1.0.1",
  versions: [{ version: "1.0.1", path: "models/m/m-1.0.1.yaml", source: null, servedName: null, variantCount: variants.length, variants }],
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
    [pair("1.0.0", "fast", [10, 30]), pair("0.9.0", "fast", [99]), pair("1.0.1", "faster", [40])]
  );

  test("a tuned variant carried forward shows the newest earlier version's pairs", () => {
    expect(tuningFor(m, "1.0.1", "fast").map((t) => t.version)).toEqual(["1.0.0"]);
    expect(tuningFor(m, "1.0.1", "faster").map((t) => t.version)).toEqual(["1.0.1"]);
    expect(tuningFor(m, "1.0.1", "base")).toEqual([]);
  });

  test("a variant's best is its best workload, out of how many", () => {
    expect(variantBest(m, "fast")).toMatchObject({ name: "w1", upliftPct: 30, of: 2 });
    expect(variantBest(m, "base")).toBeNull();
  });

  test("optimized variants come first, the biggest improvement first", () => {
    expect(orderedVariants(m).map((v) => v.id)).toEqual(["faster", "fast", "base"]);
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

test("a variant's configuration is its own lines of the version file, dedented", () => {
  const text = ["version: 1.0.0", "variants:", "  - id: a", "    engine: sglang", "    values:", "      x: 1", "  - id: b", ""].join("\n");
  expect(variantYaml(text, { from: 3, to: 6, indent: 4 })).toBe("id: a\nengine: sglang\nvalues:\n  x: 1");
});

describe("facets", () => {
  const f = (over: Partial<Facet>): Facet => ({ name: "m", displayName: "M", family: null, tags: [], engines: ["sglang"], hardware: [], hasCmp: false, uplift: null, deprecated: false, text: "", ...over });

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
    const s = computeSummary([f({ name: "a", hasCmp: true, uplift: 10, label: "a · fast" }), f({ name: "a", hasCmp: true }), f({ name: "b", deprecated: true })]);
    expect(s).toMatchObject({ models: 2, variants: 3, pairs: 1, deprecated: 1, median: 10, best: { name: "a · fast", pct: 10 } });
  });

  test("a variant's facets take its own GPUs, nodes and image", () => {
    const v = variant("fast", { isOptimized: true, requires: { gpus: 8, nodes: 2 }, image: { repository: "org/sglang", tag: "v1" } });
    const facet = variantFacetsOf(model([v], [pair("1.0.1", "fast", [12])]), v, 0);
    expect(facet).toMatchObject({ gpus: 16, uplift: 12, label: "m · fast", engines: ["sglang"] });
    expect(facet.text).toContain("org/sglang:v1");
  });
});
