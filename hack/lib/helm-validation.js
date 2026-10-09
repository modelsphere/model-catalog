"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {spawnSync} = require("node:child_process");
const YAML = require("yaml");
const {modelNames, versionFiles} = require("./catalog");

function affectsValidator(file) {
  return file.startsWith("schema/crds/") ||
    /^hack\/(validate-helm|install-helm-tools|build-crds)(\.integration)?\.(js|test\.js)$/.test(file) ||
    /^hack\/lib\/(helm-validation|crd-schema|download|catalog)(\.test)?\.js$/.test(file) ||
    ["package.json", "package-lock.json", ".github/workflows/lint.yml"].includes(file);
}

function command(bin, args, options = {}) {
  const result = spawnSync(bin, args, {encoding: "utf8", timeout: 120000, maxBuffer: 64 * 1024 * 1024, ...options});
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return {stdout, stderr, ok: result.status === 0 && !result.error,
    log: `$ ${bin} ${args.map((a) => JSON.stringify(a)).join(" ")}\n${stdout}${stderr}` +
      (result.error ? `\n${result.error.message}\n` : "") + `\nexit: ${result.status}, signal: ${result.signal ?? "none"}\n`};
}

function git(root, args) {
  const result = command("git", args, {cwd: root});
  if (!result.ok) throw new Error(result.log);
  return result.stdout;
}

// Keep both sides of renames for validator-change detection. NUL delimiters
// preserve filenames with whitespace; deleted versions are not selected.
// `added` lists the new versions, held to the chart minimum: a published version
// keeps the chart it was published with. Explicit files are checked as new.
function selectFiles(root, {all = false, base = "origin/HEAD", files = []} = {}) {
  const models = path.join(root, "models");
  const versions = modelNames(models).flatMap((name) => versionFiles(name, models));
  if (all) return {files: versions, added: [], reason: "--all"};
  if (files.length) {
    const selected = [...new Set(files.map((file) => path.relative(root, path.resolve(root, file)).split(path.sep).join("/")))].sort();
    if (selected.some((file) => !versions.includes(file))) throw new Error("explicit files must be existing model version YAMLs under models/");
    return {files: selected, added: selected, reason: "explicit files"};
  }
  const mergeBase = git(root, ["merge-base", base, "HEAD"]).trim();
  const tokens = git(root, ["diff", "--name-status", "-z", "--find-renames", mergeBase, "HEAD"]).split("\0");
  const changed = [];
  const added = [];
  for (let i = 0; i < tokens.length && tokens[i];) {
    const status = tokens[i++];
    changed.push(tokens[i++]);
    if (/^[RC]/.test(status)) changed.push(tokens[i++]);
    if (/^[ARC]/.test(status)) added.push(changed.at(-1));
  }
  const among = (list) => versions.filter((file) => list.includes(file));
  if (changed.some(affectsValidator)) {
    return {files: versions, added: among(added), reason: "validator/dependency/schema changes", mergeBase};
  }
  return {files: among(changed), added: among(added), reason: `changes since merge-base with ${base}`, mergeBase};
}

function kubeconformArgs(config, schemaDir, cacheDir, rendered) {
  // Local schemas use the FULL group. Native schemas also enforce apiVersion
  // and kind enums, so a similarly named unknown CR cannot pass as a native kind.
  return ["-strict", "-summary", "-verbose", "-output", "json", "-kubernetes-version", config.kubernetesVersion,
    "-cache", cacheDir,
    "-schema-location", `${schemaDir}/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json`,
    "-schema-location", `https://raw.githubusercontent.com/yannh/kubernetes-json-schema/${config.kubernetesSchemaCommit}/` +
      "{{.NormalizedKubernetesVersion}}-standalone{{.StrictSuffix}}/{{.ResourceKind}}{{.KindSuffix}}.json", rendered];
}

// The lines of a failed tool's output worth reading; its full log stays in the
// artifacts. kubeconform reports every resource, so keep only the invalid ones.
function failureLines(result) {
  try {
    const lines = JSON.parse(result.stdout).resources.filter((r) => !["statusValid", "statusSkipped"].includes(r.status))
      .flatMap((r) => r.validationErrors?.length ?
        r.validationErrors.map((e) => `${r.kind}/${r.name} ${e.path}: ${e.msg}`) : [`${r.kind}/${r.name}: ${r.msg}`]);
    if (lines.length) return lines;
  } catch {}
  const lines = `${result.stdout ?? ""}${result.stderr ?? ""}`.split("\n")
    .filter((line) => line.trim() && !/^(==> Linting |\[INFO\] )/.test(line));
  return lines.length ? lines : result.log.trim().split("\n");
}

// validate:schema owns a version file's shape; this only refuses to pass a file
// with nothing to render.
function parseVersions(file) {
  const variants = YAML.parse(fs.readFileSync(file, "utf8"))?.variants;
  if (!Array.isArray(variants) || !variants.length) throw new Error("variants: expected a nonempty array");
  return variants;
}

module.exports = {command, selectFiles, affectsValidator, kubeconformArgs, failureLines, parseVersions};
