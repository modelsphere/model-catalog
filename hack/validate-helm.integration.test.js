"use strict";

// Explicit, network-backed acceptance suite: npm run test:helm:integration.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const YAML = require("yaml");
const {root} = require("./lib/catalog");
const {main} = require("./validate-helm");
const {command, kubeconformArgs} = require("./lib/helm-validation");
const config = require("../schema/helm/config.json");

test("released charts: fixed/range versions, all example variants, LWS, defaults and invalid configurations", {timeout: 240000}, (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-acceptance-"));
  t.after(() => fs.rmSync(temp, {recursive: true, force: true}));
  fs.mkdirSync(path.join(temp, "models/fixtures"), {recursive: true});
  fs.mkdirSync(path.join(temp, "schema"));
  fs.symlinkSync(path.join(root, "schema/helm"), path.join(temp, "schema/helm"), "dir");
  fs.symlinkSync(path.join(root, ".cache"), path.join(temp, ".cache"), "dir");
  function write(name, doc) {
    fs.writeFileSync(path.join(temp, `models/fixtures/${name}.yaml`), YAML.stringify(doc));
  }
  for (const [name, file] of [
    ["valid-fixed", "models/glm5.3/glm5.3-1.0.0.yaml"],
    ["valid-range", "models/glm5.3/glm5.3-1.0.1.yaml"],
    ["valid-gemma", "models/gemma-4-31b-it/google-gemma-4-31b-it-1.0.0.yaml"],
    ["valid-lws", "models/kimi-k2.5/kimi-k2.5-1.0.0.yaml"]
  ]) write(name, YAML.parse(fs.readFileSync(path.join(root, file), "utf8")));
  const vllm = YAML.parse(fs.readFileSync(path.join(root, "models/kimi-k3/kimi-k3-1.0.1.yaml"), "utf8"));
  vllm.variants = vllm.variants.filter((v) => v.chart.name === "vllm");
  write("valid-vllm-fixed", vllm);
  const base = {variants: [{id: "fixture", chart: {name: "sglang", version: ">=0.8.0"}}]};
  write("valid-defaults", base);
  const invalids = [
    ["bad-key", {unkownField: true}, "lint"],
    ["bad-type", {service: {port: "bad"}}, "lint"],
    ["bad-env", {env: [{name: "TEST", value: "x", misspelled: true}]}, "kubeconform"],
    ["bad-volume", {volumes: [{name: "bad", emptyDir: {misspelled: true}}]}, "kubeconform"],
    ["bad-resources", {resources: {requsets: {cpu: "1"}}}, "kubeconform"],
    ["bad-crd", {sloRequirement: {extraSpec: {unknownSpecField: true}}}, "kubeconform"],
    ["bad-template", {sloRequirement: {extraSpec: {serviceId: "duplicate"}}}, "template"],
    ["bad-explicit-route", {modelRoute: {nginx: {outputConfigMap: ""}}}, "template"]
  ];
  for (const [name, values] of invalids) {
    const doc = structuredClone(base); doc.variants[0].values = values; write(name, doc);
  }
  const noVersion = structuredClone(base); noVersion.variants[0].chart.version = "9999.0.0";
  write("bad-resolution", noVersion);
  const legacy = structuredClone(base); legacy.variants[0].chart.version = "0.7.1";
  write("bad-legacy-chart", legacy);
  const output = path.join(temp, "artifacts");
  assert.equal(main({all: true, files: [], output}, {repositoryRoot: temp}), false);
  const summary = JSON.parse(fs.readFileSync(path.join(output, "summary.json"), "utf8"));
  for (const result of summary.results.filter((r) => path.basename(r.file).startsWith("valid-"))) {
    assert.equal(result.ok, true, `${result.file}: ${JSON.stringify(result)}`);
    const expected = {LLMScaler: "autoscaling.modelsphere.dev/v1alpha1", LLMSLORequirement: "inference.modelsphere.dev/v1alpha1",
      ModelRoute: "routing.modelsphere.dev/v1alpha1"};
    const rendered = YAML.parseAllDocuments(fs.readFileSync(path.join(temp, result.artifacts, "rendered.yaml"), "utf8"));
    for (const doc of rendered) {
      const resource = doc.toJS();
      if (expected[resource?.kind]) assert.equal(resource.apiVersion, expected[resource.kind], result.file);
    }
  }
  const fixed = summary.results.find((r) => r.file.endsWith("valid-fixed.yaml"));
  assert.equal(fixed.chart.version, "0.8.0");
  assert.equal(summary.results.find((r) => r.file.endsWith("valid-vllm-fixed.yaml")).chart.version, "0.5.0");
  assert.equal(summary.results.filter((r) => r.file.endsWith("valid-gemma.yaml")).length, 2);
  for (const [name, , stage] of invalids) {
    const result = summary.results.find((r) => r.file.endsWith(`${name}.yaml`));
    assert.equal(result.ok, false, name);
    assert.equal(result.stages[stage], false, `${name}: ${JSON.stringify(result)}`);
  }
  assert.match(summary.results.find((r) => r.file.endsWith("bad-resolution.yaml")).error, /no published/);
  assert.equal(summary.results.find((r) => r.file.endsWith("bad-legacy-chart.yaml")).stages.kubeconform, false);
  // Verify the exact production kubeconform invocation fails for unknown GVKs,
  // even if their kind resembles an existing native resource or known CRD.
  const cache = path.join(temp, "schema-cache"); fs.mkdirSync(cache);
  for (const [apiVersion, kind] of [
    ["unknown.example/v1", "Unknown"], ["wrong.example/v1", "ModelRoute"],
    ["routing.modelsphere.dev/v9", "ModelRoute"], ["apps.wrong.example/v1", "Deployment"],
    ["autoscaling.4pd.io/v1alpha1", "LLMScaler"], ["inference.x-k8s.io/v1alpha1", "LLMSLORequirement"],
    ["routing.gpucluster.io/v1alpha1", "ModelRoute"]
  ]) {
    const rendered = path.join(temp, "unknown.yaml");
    fs.writeFileSync(rendered, YAML.stringify({apiVersion, kind, metadata: {name: "unknown"}}));
    const result = command(path.join(root, ".cache/helm-validation/bin/kubeconform"),
      kubeconformArgs(config, path.join(root, "schema/helm/crds"), cache, rendered));
    assert.equal(result.ok, false, `${apiVersion}/${kind}`);
  }
});
