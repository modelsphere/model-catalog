"use strict";
// The server's settings: one YAML file, named on the command line
// (catalog-server --config <file>; catalog-server.yaml in the working
// directory by default). catalog-server.example.yaml has every setting, with
// what it does. A relative path in it is from the file's own directory, so a
// config and what it names move together.
//
// An unknown setting is an error rather than ignored: a misspelt one would
// otherwise leave its default in force without a word.

const fs = require("fs");
const path = require("path");
const yaml = require("yaml");

const SETTINGS = {
  port: "number",
  basePath: "string",
  repository: { dir: "string", branch: "string", syncInterval: "number", template: "string" },
  committer: { name: "string", email: "string" },
  tokensFile: "string",
  pagesDir: "string",
};

// Settings that are no longer the server's, and where they went.
const MOVED = {
  publicUrl: " -- where the catalog is served is its catalog.yaml's site and raw, which setting it up writes",
};

// What is wrong with doc against shape, as "key: problem" lines.
function shapeProblems(doc, shape, at = "") {
  if (doc == null) return [];
  if (typeof doc !== "object" || Array.isArray(doc)) return [`${at || "the file"}: want a mapping`];
  return Object.entries(doc).flatMap(([k, v]) => {
    const key = at ? `${at}.${k}` : k;
    const want = shape[k];
    if (!want) return [`${key}: not a setting (${Object.keys(shape).join(", ")})${MOVED[key] ?? ""}`];
    if (typeof want === "object") return shapeProblems(v, want, key);
    return v == null || typeof v === want ? [] : [`${key}: want a ${want}`];
  });
}

// The settings in file, checked, with defaults filled in and paths resolved.
function loadConfig(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(
      `${file}: ${err.code === "ENOENT" ? "no such file -- copy catalog-server.example.yaml there, or pass --config <file>" : err.message}`,
    );
  }
  let doc;
  try {
    doc = yaml.parse(text) ?? {};
  } catch (err) {
    throw new Error(`${file}: not YAML: ${err.message.split("\n")[0]}`);
  }
  const problems = shapeProblems(doc, SETTINGS);
  const from = (p) => (p == null ? null : path.resolve(path.dirname(path.resolve(file)), p));
  const repo = doc.repository ?? {};

  const port = doc.port ?? 8000;
  if (!Number.isInteger(port) || port < 0 || port > 65535) problems.push(`port: ${port} is not a port`);
  const syncInterval = repo.syncInterval ?? 30;
  if (!(syncInterval >= 0)) problems.push(`repository.syncInterval: want seconds, 0 for never`);
  const template = from(repo.template);
  if (template && !fs.existsSync(path.join(template, "catalog.yaml"))) {
    problems.push(`repository.template: ${template} has no catalog.yaml -- a template is the files a new catalog starts with`);
  }
  const pagesDir = from(doc.pagesDir);
  if (pagesDir && !fs.existsSync(path.join(pagesDir, "index.html"))) {
    problems.push(`pagesDir: ${pagesDir} has no index.html -- want model-catalog's npm run build:web output (dist/web)`);
  }
  if (problems.length) throw new Error(`${file}:\n  ${problems.join("\n  ")}`);

  return {
    port,
    basePath: `/${doc.basePath ?? "/"}/`.replace(/\/+/g, "/"),
    repository: {
      dir: from(repo.dir ?? "data/catalog"),
      branch: repo.branch ?? null,
      syncInterval,
      template,
    },
    committer: { name: doc.committer?.name ?? "catalog-server", email: doc.committer?.email ?? "catalog-server@localhost" },
    tokensFile: from(doc.tokensFile),
    pagesDir,
  };
}

// The config file the command line names: --config <file>, or --config=<file>.
function configPath(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config") return argv[i + 1];
    if (argv[i].startsWith("--config=")) return argv[i].slice("--config=".length);
  }
  return "catalog-server.yaml";
}

module.exports = { loadConfig, configPath };
