"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const YAML = require("yaml");
const {main, options} = require("./validate-helm");
const config = require("../schema/helm/config.json");

function fixture(t, failure, {chartName = "sglang", declaredVersion = "0.8.0", latestVersion = "0.8.0"} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "helm-validator-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const file = "models/example/example-1.0.0.yaml";
  fs.mkdirSync(path.join(root, "models/example"), {recursive: true});
  fs.writeFileSync(path.join(root, file), YAML.stringify({variants: [
    {id: "default", default: true, chart: {name: chartName, version: declaredVersion}},
    {id: "other", chart: {name: chartName, version: `>=${config.minimumChartVersions[chartName]}`}, values: {extraArgs: ["--other"]}}
  ]}));
  fs.mkdirSync(path.join(root, "schema/helm"), {recursive: true});
  fs.writeFileSync(path.join(root, "schema/helm/provenance.json"), JSON.stringify({converterVersion: config.converterVersion, sources: []}));
  const calls = [];
  const bytes = Buffer.from("fixture-package");
  let prereleaseInserted = false;
  const runCommand = (bin, args, opts) => {
    calls.push(args);
    let stdout = "";
    if (args[0] === "version") stdout = `v${config.helmVersion}+test`;
    else if (args[0] === "-v") stdout = `v${config.kubeconformVersion}`;
    else if (args[0] === "repo") {
      const dir = path.join(opts.env.HELM_CACHE_HOME, "repository");
      fs.mkdirSync(dir, {recursive: true});
      fs.writeFileSync(path.join(dir, "catalog-index.yaml"), YAML.stringify({entries: {[chartName]:
        [...new Set([latestVersion, declaredVersion])].map((version) => ({version, digest: crypto.createHash("sha256").update(bytes).digest("hex")}))
      }}));
    } else if (args[0] === "search") {
      const constraint = args[args.indexOf("--version") + 1];
      const version = constraint === declaredVersion ? declaredVersion : latestVersion;
      const matches = failure === "resolution" || failure === "latest-resolution" && constraint.startsWith(">=") ? [] : [{name: `catalog/${chartName}`, version}];
      if (matches.length) matches.unshift({name: `catalog/${chartName}-other`, version: "98.0.0"});
      // Inject a prerelease into the first latest lookup to exercise its filter.
      if (failure === "prerelease" && constraint.startsWith(">=") && !prereleaseInserted) {
        matches.unshift({name: `catalog/${chartName}`, version: "99.0.0-rc.1"});
        prereleaseInserted = true;
      }
      stdout = JSON.stringify(matches);
    }
    else if (args[0] === "pull") fs.writeFileSync(path.join(args.at(-1), `${chartName}-${args[args.indexOf("--version") + 1]}.tgz`), bytes);
    else if (args[0] === "-tzf") stdout = failure === "schema" ? `${chartName}/Chart.yaml\n` : `${chartName}/Chart.yaml\n${chartName}/values.schema.json\n`;
    else if (args[0] === "show") stdout = YAML.stringify({name: chartName,
      version: path.basename(args.at(-1)).slice(chartName.length + 1, -4)});
    else if (args[0] === "template") stdout = failure === "empty" ? "" : "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: example\n";
    const stage = args[0] === "-strict" ? "kubeconform" : args[0] === "pull" ? "download" :
      args[0].endsWith("build-crds.js") ? "crds" : args[0];
    const ok = stage !== failure;
    return {stdout, ok, log: ok ? stdout : `${stage}: fixture failure at spec.template.spec.containers[0].env[0]\n`};
  };
  const output = path.join(root, "artifacts");
  const run = (opts = {}) => main({all: true, files: [], output, ...opts}, {repositoryRoot: root, runCommand});
  const summary = () => JSON.parse(fs.readFileSync(path.join(output, "summary.json"), "utf8"));
  return {run, summary, calls, root};
}

test("every variant uses independent values and the resolved package is reused", (t) => {
  const f = fixture(t);
  assert.equal(f.run(), true);
  const s = f.summary();
  assert.equal(s.results.length, 2);
  assert(s.results.every((r) => r.ok && r.chart.version === "0.8.0" && r.chart.digest.startsWith("sha256:")));
  assert.equal(f.calls.filter((a) => a[0] === "pull").length, 1);
  const values = s.results.map((r) => YAML.parse(fs.readFileSync(path.join(f.root, r.artifacts, "values.yaml"), "utf8")));
  assert.equal(values[0].extraArgs, undefined);
  assert.deepEqual(values[1].extraArgs, ["--other"]);
  assert(f.calls.filter((a) => ["lint", "template"].includes(a[0])).every((a) => a.includes(config.kubernetesVersion)));
});

for (const [chartName, declaredVersion, latestVersion] of [["sglang", "0.8.0", "1.2.0"], ["vllm", "0.5.0", "1.3.0"]]) {
  test(`${chartName} latest mode checks a future stable release beyond a fixed pin`, (t) => {
    const f = fixture(t, "prerelease", {chartName, declaredVersion, latestVersion});
    assert.equal(f.run(), true);
    const s = f.summary();
    assert.equal(s.chartMode, "latest");
    assert(s.results.every((r) => r.chart.version === latestVersion));
    assert.equal(s.results[0].chart.declaredVersion, declaredVersion);
    assert.equal(s.results[0].declaredChart.version, declaredVersion);
    assert.equal(f.calls.filter((a) => a[0] === "pull").length, 1);
    assert(f.calls.filter((a) => a[0] === "pull").every((a) => a.includes(latestVersion)));
    assert(f.calls.filter((a) => a[0] === "search").every((a) => !a.includes("--devel")));
  });
}

test("declared mode checks the fixed deployment release independently of latest", (t) => {
  const f = fixture(t, undefined, {latestVersion: "1.2.0"});
  assert.equal(f.run({chartMode: "declared"}), true);
  assert.equal(f.summary().results[0].chart.version, "0.8.0");
  assert.equal(f.summary().results[0].chart.mode, "declared");
});

test("a new version below the baseline cannot pass by checking a newer chart", (t) => {
  const f = fixture(t, undefined, {declaredVersion: "0.7.1"});
  assert.equal(f.run({all: false, files: ["models/example/example-1.0.0.yaml"]}), false);
  assert.match(f.summary().results[0].error, /below the required minimum 0.8.0/);
});

test("a published version below the baseline warns and its values are checked against latest", (t) => {
  const f = fixture(t, undefined, {declaredVersion: "0.7.1", latestVersion: "0.8.2"});
  assert.equal(f.run(), true);
  const [legacy] = f.summary().results;
  assert.equal(legacy.ok, true);
  assert.match(legacy.warning, /0.7.1 is below the required minimum 0.8.0/);
  assert.equal(legacy.chart.version, "0.8.2");
});

test("declared mode skips a published version below the baseline instead of rendering its legacy chart", (t) => {
  const f = fixture(t, undefined, {declaredVersion: "0.7.1"});
  assert.equal(f.run({chartMode: "declared"}), true);
  const [legacy, other] = f.summary().results;
  assert.equal(legacy.skipped, true);
  assert.equal(other.ok, true);
  assert(f.calls.filter((a) => a[0] === "pull").every((a) => !a.includes("0.7.1")));
});

test("missing latest release does not fall back to a valid declared pin", (t) => {
  const f = fixture(t, "latest-resolution");
  assert.equal(f.run(), false);
  assert(f.summary().results.every((r) => !r.ok));
  assert.equal(f.calls.filter((a) => a[0] === "pull").length, 0);
});

for (const failure of ["crds", "resolution", "download", "schema", "lint", "template", "kubeconform", "empty"]) {
  test(`${failure} failure cannot report success`, (t) => {
    const f = fixture(t, failure);
    assert.equal(f.run(), false);
    assert(f.summary().results.every((r) => !r.ok));
    if (failure === "lint") assert.equal(f.calls.filter((a) => a[0] === "template").length, 2);
    if (failure === "template") assert.equal(f.calls.filter((a) => a[0] === "-strict").length, 0);
  });
}

test("CLI rejects ambiguous selectors and incomplete arguments", () => {
  assert.throws(() => options(["--all", "--base", "main"]));
  assert.throws(() => options(["--base"]));
  assert.throws(() => options(["--unknown"]));
  assert.throws(() => options(["--chart-mode", "invalid"]));
  assert.throws(() => options(["--chart-mode"]));
  assert.equal(options([]).chartMode, "latest");
  assert.equal(options(["--all", "--chart-mode", "declared"]).chartMode, "declared");
});
