"use strict";
// Test helpers: throwaway catalogs in git, and a server over one.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const YAML = require("yaml");
const { Repo } = require("../src/git");
const { Store } = require("../src/store");
const { Tokens } = require("../src/tokens");
const { createServer } = require("../src/server");

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const git = (dir, args, at) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd: dir,
    env: { ...process.env, ...(at && { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at }) },
    stdio: "pipe",
  })
    .toString()
    .trim();

// A catalog's bare repository, and a working clone of it: each step writes
// files (null deletes), commits at a UTC time and pushes, as someone outside
// the server would.
function catalogRepo(steps = []) {
  const bare = tmp("catalog-repo-");
  git(bare, ["init", "-q", "--bare", "-b", "main"]);
  const work = tmp("work-");
  git(work, ["init", "-q", "-b", "main"]);
  git(work, ["remote", "add", "origin", bare]);
  const commit = (at, subject, files) => {
    for (const [rel, body] of Object.entries(files)) {
      const file = path.join(work, rel);
      if (body === null) fs.rmSync(file);
      else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof body === "string" ? body : YAML.stringify(body));
      }
    }
    git(work, ["add", "-A"], at);
    git(work, ["commit", "-q", "-m", subject], at);
    git(work, ["push", "-q", "origin", "HEAD:main"]);
    return git(work, ["rev-parse", "HEAD"]);
  };
  for (const step of steps) commit(...step);
  return {
    dir: bare,
    work,
    commit,
    head: () => git(bare, ["rev-parse", "main"]),
    show: (spec) => git(bare, ["show", "-s", "--format=%an <%ae>|%cn|%s", spec]),
    // The working clone, at the repository's tip again.
    pull: () => git(work, ["pull", "-q", "--rebase", "origin", "main"]),
    rm: () => [bare, work].forEach((d) => fs.rmSync(d, { recursive: true, force: true })),
  };
}

const variant = (id, version = "1.0.0", gpus = 8, model = "m2") => ({
  apiVersion: "catalog.swiss/v2",
  kind: "Variant",
  model,
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
    variants: [{ id: "a", engine: "vllm", chart: { name: "vllm", version: "0.1.0" }, requires: { gpus: 1 } }],
  },
  "models/m2/metadata.yaml": { apiVersion: "catalog.swiss/v2", name: "m2", source: { hf: "o/m2" }, defaultVariant: "sglang-tp8" },
  "models/m2/sglang-tp8.yaml": variant("sglang-tp8"),
  "models/m2/sglang-tp4.yaml": variant("sglang-tp4", "1.0.0", 4),
};

const TOKEN = "t0ken-for-ada-lovelace";
const tokensYaml = `- name: Ada Lovelace\n  email: ada@example.com\n  token: ${TOKEN}\n`;

// A server over the catalog repository at dir (null: a new one). Resolves to {base, store, fetch, close}; fetch takes a path
// under the base, with the token unless auth says otherwise.
async function serve({ dir = null, tokens = tokensYaml, base: basePath = "/", template } = {}) {
  const home = tmp("server-");
  const repo = Repo.open({ dir: dir ?? path.join(home, "catalog"), branch: "main" });
  let tokenFile = null;
  if (tokens !== null) {
    tokenFile = path.join(home, "tokens.yaml");
    fs.writeFileSync(tokenFile, tokens);
  }
  const quiet = { log() {}, warn() {} };
  const store = await new Store({ repo, log: quiet }).start();
  const server = createServer({ store, tokens: tokenFile && new Tokens(tokenFile), base: basePath, template, log: quiet });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}${basePath}`;
  const call = (rel, { auth = TOKEN, headers = {}, ...init } = {}) =>
    fetch(base + rel, { ...init, headers: { ...(auth && { Authorization: `Bearer ${auth}` }), ...headers } });
  return {
    base,
    store,
    repo,
    tokenFile,
    fetch: call,
    json: async (rel, init) => {
      const res = await call(rel, init);
      return { status: res.status, etag: res.headers.get("etag"), body: await res.json() };
    },
    close: () => {
      server.close();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

module.exports = { catalogRepo, serve, variant, catalogFiles, git, tmp, TOKEN, YAML };
