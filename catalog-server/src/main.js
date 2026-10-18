#!/usr/bin/env node
"use strict";
// catalog-server: a schema v2 model catalog that is written to, served from
// its git repository. Its settings are a config file (config.js):
//
//   catalog-server --config catalog-server.yaml
//   catalog-server --config catalog-server.yaml --healthcheck
//                  # exits 0 when the server it configures answers /healthz

const { loadConfig, configPath } = require("./config");
const { Repo } = require("./git");
const { Store } = require("./store");
const { Tokens } = require("./tokens");
const { createServer } = require("./server");

async function main(argv) {
  const file = configPath(argv);
  const cfg = loadConfig(file);
  if (argv.includes("--healthcheck")) {
    const res = await fetch(`http://127.0.0.1:${cfg.port}/healthz`);
    process.exit(res.ok ? 0 : 1);
  }

  const { dir, branch, syncInterval } = cfg.repository;
  const repo = Repo.open({ dir, branch, committer: cfg.committer });
  const tokens = cfg.tokensFile && new Tokens(cfg.tokensFile);
  // A broken tokens file is found now, not at the first write.
  if (tokens) console.log(`writes: ${tokens.load().length} tokens in ${cfg.tokensFile}`);
  else console.log("writes: off (no tokensFile)");
  const store = await new Store({ repo }).start();
  if (syncInterval > 0) store.follow(syncInterval * 1000);
  const server = createServer({ store, tokens, base: cfg.basePath, pages: cfg.pagesDir, template: cfg.repository.template ?? undefined });
  server.listen(cfg.port, "0.0.0.0", () => {
    const at = `http://127.0.0.1:${cfg.port}${cfg.basePath}`;
    console.log(
      `catalog-server (${file}): ${at}index-v2.json at ${store.snapshot.commit?.slice(0, 12) ?? "no commit yet"}, from ${dir} (${repo.made ? repo.branch : "no repository yet"})`,
    );
    if (cfg.pagesDir) console.log(`  pages: ${at} (${cfg.pagesDir})`);
    // The catalog's say, not the server's: nothing checks it is where clients reach it.
    if (store.snapshot.index.site) console.log(`  served, its catalog.yaml says, at ${store.snapshot.index.site}`);
    if (!store.snapshot.tree.has("catalog.yaml")) console.log(`  not initialized: POST ${at}api/v2/init`);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
