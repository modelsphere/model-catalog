"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {execFileSync} = require("node:child_process");
const {selectFiles, kubeconformArgs, failureLines} = require("./helm-validation");
const config = require("../../schema/crds/config.json");

function repository(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "helm-selection-"));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const git = (...args) => execFileSync("git", args, {cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]}).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Validator Test");
  git("config", "user.email", "validator@example.invalid");
  function write(file, body = "test\n") {
    fs.mkdirSync(path.dirname(path.join(dir, file)), {recursive: true});
    fs.writeFileSync(path.join(dir, file), body);
  }
  function commit() { git("add", "."); git("commit", "-m", "fixture"); }
  write("models/example/example-1.0.0.yaml");
  write("models/example/metadata.yaml");
  write("hack/validate-helm.js");
  commit();
  git("branch", "base");
  return {dir, git, write, commit};
}

test("documentation and metadata changes select no version files", (t) => {
  const r = repository(t);
  r.write("README.md"); r.write("models/example/metadata.yaml", "modified\n"); r.commit();
  assert.deepEqual(selectFiles(r.dir, {base: "base"}).files, []);
});

test("add, modify and rename destinations are selected; deletions are excluded", (t) => {
  const r = repository(t);
  r.write("models/example/example-1.1.0.yaml"); r.commit();
  r.git("branch", "before");
  r.git("mv", "models/example/example-1.0.0.yaml", "models/example/renamed version-1.0.0.yaml");
  r.write("models/example/example-1.1.0.yaml", "modified\n");
  r.write("models/example/example-1.2.0.yaml"); r.commit();
  assert.deepEqual(selectFiles(r.dir, {base: "before"}).files, [
    "models/example/example-1.1.0.yaml", "models/example/example-1.2.0.yaml", "models/example/renamed version-1.0.0.yaml"]);
  r.git("rm", "models/example/example-1.2.0.yaml"); r.commit();
  assert(!selectFiles(r.dir, {base: "before"}).files.includes("models/example/example-1.2.0.yaml"));
});

test("selection uses the common ancestor even when the target branch advances", (t) => {
  const r = repository(t);
  r.write("models/example/feature-1.0.0.yaml"); r.commit();
  r.git("checkout", "base"); r.write("models/example/base-only-1.0.0.yaml"); r.commit();
  r.git("checkout", "main");
  assert.deepEqual(selectFiles(r.dir, {base: "base"}).files, ["models/example/feature-1.0.0.yaml"]);
});

test("validator, dependency and schema changes, including deletions, trigger all versions", (t) => {
  for (const file of ["hack/validate-helm.js", "hack/build-crds.js", "hack/lib/crd-schema.js", "schema/crds/config.json", "package-lock.json", ".github/workflows/lint.yml"]) {
    const r = repository(t);
    r.write(file, "changed\n"); r.commit();
    assert.equal(selectFiles(r.dir, {base: "base"}).reason, "validator/dependency/schema changes");
  }
  const r = repository(t);
  r.git("rm", "hack/validate-helm.js"); r.commit();
  assert.equal(selectFiles(r.dir, {base: "base"}).reason, "validator/dependency/schema changes");
  const renamed = repository(t);
  renamed.git("mv", "hack/validate-helm.js", "archived-validator.txt"); renamed.commit();
  assert.equal(selectFiles(renamed.dir, {base: "base"}).reason, "validator/dependency/schema changes");
});

test("only added versions are held to the chart minimum, also in a full scan", (t) => {
  const r = repository(t);
  r.write("models/example/example-1.0.0.yaml", "modified\n");
  r.write("models/example/example-1.1.0.yaml");
  r.write("hack/validate-helm.js", "changed\n"); r.commit();
  const selection = selectFiles(r.dir, {base: "base"});
  assert.deepEqual(selection.files, ["models/example/example-1.0.0.yaml", "models/example/example-1.1.0.yaml"]);
  assert.deepEqual(selection.added, ["models/example/example-1.1.0.yaml"]);
  assert.deepEqual(selectFiles(r.dir, {all: true}).added, []);
  assert.deepEqual(selectFiles(r.dir, {files: ["models/example/example-1.0.0.yaml"]}).added, ["models/example/example-1.0.0.yaml"]);
});

test("unknown base fails rather than reporting no changes", (t) => {
  const r = repository(t);
  assert.throws(() => selectFiles(r.dir, {base: "missing-ref"}));
});

test("strict validation uses full group and pinned native schema without missing-schema bypass", () => {
  const args = kubeconformArgs(config, "/schemas", "/cache", "/rendered.yaml");
  assert(args.includes("-strict"));
  assert(!args.includes("-ignore-missing-schemas"));
  assert(args.some((arg) => arg.includes("{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}")));
  assert(args.some((arg) => arg.includes(config.kubernetesSchemaCommit)));
});

test("failure lines keep the invalid resources and the errors, not every resource or the command", () => {
  const resources = [
    {kind: "Service", name: "ok", status: "statusValid", msg: ""},
    {kind: "Deployment", name: "app", status: "statusInvalid", msg: "problem validating schema",
      validationErrors: [{path: "/spec/replicas", msg: "expected integer"}]},
    {kind: "Widget", name: "w", status: "statusError", msg: "could not find schema for Widget"}
  ];
  assert.deepEqual(failureLines({stdout: JSON.stringify({resources}), stderr: "", log: "$ kubeconform\n"}),
    ["Deployment/app /spec/replicas: expected integer", "Widget/w: could not find schema for Widget"]);
  assert.deepEqual(failureLines({stdout: "==> Linting /tmp/chart.tgz\n[INFO] Chart.yaml: icon is recommended\n[ERROR] values.yaml: bad\n\n",
    stderr: "Error: 1 chart(s) failed\n", log: "$ helm lint\n"}), ["[ERROR] values.yaml: bad", "Error: 1 chart(s) failed"]);
  // A tool that printed nothing, such as one killed by a timeout, still says why.
  assert.deepEqual(failureLines({stdout: "", stderr: "", log: "$ helm lint\nspawnSync helm ETIMEDOUT\n"}), ["$ helm lint", "spawnSync helm ETIMEDOUT"]);
});
