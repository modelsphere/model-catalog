#!/usr/bin/env node
// The catalog server: this checkout as a catalog, live from models/, at the
// paths the published site has them.
//
//   GET /index-v2.json                 v2 models and their variant files: what
//                                      the web app renders from
//   GET /models/<name>/<id>.yaml       the variant files it names
//   GET /models/<name>/<id>.history.json
//   GET /models/<name>/<report>.html   perf reports
//   GET /index.json                    the v1 index swiss reads, built per request
//   GET /models/<name>/<file>.yaml     the version files it names
//
//   npm run serve                      # http://127.0.0.1:8000
//   npm run serve -- 9000
//   swiss catalog list --catalog http://127.0.0.1:8000
//
// npm run dev:site starts one too, as the backend its pages fetch from.
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { execFileSync } = require("child_process");
const { root, historyPath } = require("../hack/lib/catalog");
const { checkedIndexV2, buildIndex, serializeIndex } = require("./data");

const TYPES = { ".json": "application/json", ".yaml": "text/yaml; charset=utf-8", ".html": "text/html; charset=utf-8" };

// A catalog server. index-v2.json is built once and again after an edit under
// models/ or a commit: it reads git history, which takes a moment. index.json
// is cheap, so it is always built fresh. root is the checkout served.
function createServer({ root: base = root } = {}) {
  const modelsDir = path.join(base, "models");
  let v2 = null;
  const watcher = fs.watch(modelsDir, { recursive: true }, () => (v2 = null));
  // Rebuilt after a commit too: versions come from git.
  const head = () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: base, encoding: "utf8" }).trim();
  const indexV2 = () => {
    const at = head();
    if (v2?.at !== at) {
      const { index, histories } = checkedIndexV2({ root: base });
      v2 = {
        at,
        index: serializeIndex(index),
        histories: new Map([...histories].map(([rel, h]) => [historyPath(rel), JSON.stringify(h, null, 2) + "\n"])),
      };
    }
    return v2;
  };

  const server = http.createServer((req, res) => {
    const send = (status, type, body) => {
      res.writeHead(status, {
        "Content-Type": type,
        "Cache-Control": "no-store",
        // A public catalog: any page may read it.
        "Access-Control-Allow-Origin": "*",
      });
      res.end(req.method === "HEAD" ? undefined : body);
    };
    if (req.method !== "GET" && req.method !== "HEAD") return send(405, "text/plain", "GET only\n");
    let url;
    try {
      url = decodeURIComponent(new URL(req.url, "http://catalog").pathname);
    } catch {
      return send(400, "text/plain", "bad path\n");
    }
    try {
      if (url === "/index.json") return send(200, TYPES[".json"], serializeIndex(buildIndex({ root: base })));
      if (url === "/index-v2.json") return send(200, TYPES[".json"], indexV2().index);
      if (/^\/models\/[^/]+\/[^/]+\.history\.json$/.test(url)) {
        const body = indexV2().histories.get(url.slice(1));
        return body ? send(200, TYPES[".json"], body) : send(404, "text/plain", "not in this catalog\n");
      }
      const file = path.join(base, url);
      if (/^\/models\/[^/]+\/[^/]+\.(yaml|html)$/.test(url) && file.startsWith(modelsDir + path.sep) && fs.existsSync(file)) {
        return send(200, TYPES[path.extname(file)], fs.readFileSync(file));
      }
      return send(404, "text/plain", "not in this catalog\n");
    } catch (err) {
      return send(500, "text/plain", `${err.message}\n`);
    }
  });
  server.on("close", () => watcher.close());
  return server;
}

module.exports = { createServer };

if (require.main === module) {
  const port = Number(process.argv[2] || process.env.PORT || 8000);
  // Every interface, so a swiss elsewhere on the network can read it.
  createServer().listen(port, "0.0.0.0", () => console.log(`catalog server: http://127.0.0.1:${port}/index.json`));
}
