"use strict";
// Test helpers: a throwaway catalog checkout, so tests exercise the code
// rather than this repo's own models/ (validate:schema checks those).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const YAML = require("yaml");

// A git repo; each step writes files (null deletes) and commits at a UTC time.
function fixture(steps) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-"));
  const git = (args, at) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      cwd: dir,
      env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
      stdio: "pipe",
    });
  git(["init", "-q", "-b", "master"]);
  const write = (files) => {
    for (const [rel, body] of Object.entries(files)) {
      const file = path.join(dir, rel);
      if (body === null) fs.rmSync(file);
      else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof body === "string" ? body : YAML.stringify(body));
      }
    }
  };
  const commit = (at, subject, files) => {
    write(files);
    git(["add", "-A"], at);
    git(["commit", "-q", "-m", subject], at);
  };
  for (const step of steps) commit(...step);
  return {
    dir,
    write,
    commit,
    head: () => git(["rev-parse", "HEAD"]).toString().trim(),
    sha: (n) =>
      git(["rev-parse", `HEAD~${n}`])
        .toString()
        .trim(),
  };
}

const variant = (id, version = "1.0.0", gpus = 8) => ({
  apiVersion: "catalog.swiss/v2",
  kind: "Variant",
  model: "m2",
  id,
  version,
  engine: "sglang",
  chart: { name: "sglang", version: ">=0.7.0" },
  requires: { gpus },
});

// m1 on v1 (one version file), m2 on v2 (two variant files).
const catalogFiles = {
  "catalog.yaml": { apiVersion: "catalog.swiss/v1", site: "https://example.com/c/", repo: "https://github.com/o/c" },
  "models/m1/metadata.yaml": { apiVersion: "catalog.swiss/v1", name: "m1", source: { hf: "o/m1" } },
  "models/m1/m1-1.0.0.yaml": {
    apiVersion: "catalog.swiss/v1",
    name: "m1",
    version: "1.0.0",
    variants: [
      { id: "a", engine: "vllm", chart: { name: "vllm", version: "0.1.0" }, requires: { gpus: 1 } },
      { id: "b", default: true, engine: "vllm", chart: { name: "vllm", version: "0.1.0" }, requires: { gpus: 2 } },
    ],
  },
  "models/m2/metadata.yaml": { apiVersion: "catalog.swiss/v2", name: "m2", source: { hf: "o/m2" }, defaultVariant: "sglang-tp8" },
  "models/m2/sglang-tp8.yaml": variant("sglang-tp8"),
  "models/m2/sglang-tp4.yaml": variant("sglang-tp4", "1.0.0", 4),
};

// A perf report validate:schema accepts, and the site links.
const report =
  `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>r</title></head>\n<body>\n` +
  `<div id="report"></div>\n<script type="application/json" id="report-data">{"rows": [1]}</script>\n</body>\n</html>\n`;

module.exports = { fixture, variant, catalogFiles, report };
