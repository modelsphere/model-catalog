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

function fixture(t, failure) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "helm-validator-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const file = "models/example/example-1.0.0.yaml";
  fs.mkdirSync(path.join(root, "models/example"), {recursive: true});
  fs.writeFileSync(path.join(root, file), YAML.stringify({variants: [
    {id: "default", default: true, chart: {name: "sglang", version: "0.7.1"}},
    {id: "other", chart: {name: "sglang", version: ">=0.7.1"}, values: {extraArgs: ["--other"]}}
  ]}));
  fs.mkdirSync(path.join(root, "schema/helm"), {recursive: true});
  fs.writeFileSync(path.join(root, "schema/helm/provenance.json"), JSON.stringify({converterVersion: config.converterVersion, sources: []}));
  const calls = [];
  const bytes = Buffer.from("fixture-package");
  const runCommand = (bin, args, opts) => {
    calls.push(args);
    let stdout = "";
    if (args[0] === "version") stdout = `v${config.helmVersion}+test`;
    else if (args[0] === "-v") stdout = `v${config.kubeconformVersion}`;
    else if (args[0] === "repo") {
      const dir = path.join(opts.env.HELM_CACHE_HOME, "repository");
      fs.mkdirSync(dir, {recursive: true});
      fs.writeFileSync(path.join(dir, "catalog-index.yaml"), YAML.stringify({entries: {sglang: [
        {version: "0.7.1", digest: crypto.createHash("sha256").update(bytes).digest("hex")}
      ]}}));
    } else if (args[0] === "search") stdout = JSON.stringify(failure === "resolution" ? [] : [{name: "catalog/sglang", version: "0.7.1"}]);
    else if (args[0] === "pull") fs.writeFileSync(path.join(args.at(-1), "sglang-0.7.1.tgz"), bytes);
    else if (args[0] === "-tzf") stdout = failure === "schema" ? "sglang/Chart.yaml\n" : "sglang/Chart.yaml\nsglang/values.schema.json\n";
    else if (args[0] === "show") stdout = "name: sglang\nversion: 0.7.1\n";
    else if (args[0] === "template") stdout = failure === "empty" ? "" : "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: example\n";
    const stage = args[0] === "-strict" ? "kubeconform" : args[0] === "pull" ? "download" : args[0];
    const ok = stage !== failure;
    return {stdout, ok, log: ok ? stdout : `${stage}: fixture failure at spec.template.spec.containers[0].env[0]\n`};
  };
  const output = path.join(root, "artifacts");
  const run = () => main({all: true, files: [], output}, {repositoryRoot: root, runCommand});
  const summary = () => JSON.parse(fs.readFileSync(path.join(output, "summary.json"), "utf8"));
  return {run, summary, calls, root};
}

test("every variant uses independent values and the resolved package is reused", (t) => {
  const f = fixture(t);
  assert.equal(f.run(), true);
  const s = f.summary();
  assert.equal(s.results.length, 2);
  assert(s.results.every((r) => r.ok && r.chart.version === "0.7.1" && r.chart.digest.startsWith("sha256:")));
  assert.equal(f.calls.filter((a) => a[0] === "pull").length, 1);
  const values = s.results.map((r) => YAML.parse(fs.readFileSync(path.join(f.root, r.artifacts, "values.yaml"), "utf8")));
  assert.equal(values[0].extraArgs, undefined);
  assert.deepEqual(values[1].extraArgs, ["--other"]);
  assert(f.calls.filter((a) => ["lint", "template"].includes(a[0])).every((a) => a.includes(config.kubernetesVersion)));
});

for (const failure of ["resolution", "download", "schema", "lint", "template", "kubeconform", "empty"]) {
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
});
