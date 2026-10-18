"use strict";
// The HTTP server, under a base path (/ by default). Reads are at the paths
// model-catalog's published site has them, so swiss and the web app read this
// as they read that; writes are under api/v2/ and need a token.
//
//   GET    index-v2.json                       the catalog
//   GET    models/<name>/<id>.yaml             the variant files it names
//   GET    models/<name>/<id>.history.json     each one's revisions
//   GET    models/<name>/<report>.html         perf reports
//   GET    raw/<commit>/models/<name>/<f>.yaml a file as committed: where
//                                              swiss fetches an old revision
//
//   GET    api/v2/models/<name>/variants/<id>  a variant file, its digest as ETag
//   PUT    api/v2/models/<name>/variants/<id>  add it (If-None-Match: *) or
//                                              replace it (If-Match: <digest>)
//   DELETE api/v2/models/<name>/variants/<id>  (If-Match: <digest>)
//   GET    api/v2/models/<name>/metadata       metadata.yaml, its digest as ETag
//   PUT    api/v2/models/<name>/metadata       (If-Match: <digest>)
//   POST   api/v2/models                       a new model: {metadata, variants}
//   GET    api/v2/                             what this server takes: the web
//                                              app turns editing on by it
//   GET    api/v2/init                         whether the catalog is initialized
//   POST   api/v2/init                         initialize it: commit the
//                                              template's files ({"repo": url})
//
//   GET    /healthz                            at the server's root
//
// A write takes ?dryRun=true to check it without committing, and
// X-Commit-Message or ?message= for its commit's message (the query, for
// text a header cannot carry). With pages (model-catalog's npm
// run build:web), the web app is served too, at the base path.

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { HttpError, initialized, initialize, putVariant, deleteVariant, putMetadata, createModel, tag } = require("./writes");
const { templateFiles, BUILT_IN } = require("./template");
const { digest } = require("./catalog");

const TYPES = {
  ".json": "application/json",
  ".yaml": "application/yaml; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

// What model-catalog's build:web writes in place of the base path, which the
// server fills in as it serves the pages: one build serves under any.
const BASE_MARK = "/__catalog_base__/";

// A page the web app routes, rather than a file: each gets index.html.
const ROUTES = /^(?:|index\.html|models\.html|variants\.html|models\/[^/]+\/?|models\/[^/]+\/index\.html)$/;

const MAX_BODY = 1 << 20;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, `a body is at most ${MAX_BODY} bytes`));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// The pages, read once, with their base path filled in.
function pageReader(dir, base) {
  const cache = new Map();
  return (rel) => {
    if (!dir) return null;
    if (cache.has(rel)) return cache.get(rel);
    const file = path.join(dir, rel);
    let body = null;
    if (file.startsWith(dir + path.sep) && fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
      body = fs.readFileSync(file);
      if (/\.(?:html|js|css)$/.test(rel)) body = Buffer.from(body.toString("utf8").replaceAll(BASE_MARK, base));
    }
    cache.set(rel, body);
    return body;
  };
}

// store, the catalog (store.js); tokens, who may write (tokens.js), or null
// for a catalog no one writes; pages, the web app's build, or null; template,
// what POST api/v2/init commits (template.js).
function createServer({ store, tokens = null, base = "/", pages = null, template = BUILT_IN, log = console }) {
  if (!base.startsWith("/") || !base.endsWith("/")) throw new Error(`base ${base}: want a path starting and ending with /`);
  const page = pageReader(pages, base);

  return http.createServer(async (req, res) => {
    const send = (status, type, body, headers = {}) => {
      res.writeHead(status, {
        "Content-Type": type,
        "Cache-Control": "no-cache",
        // Any page may read the catalog, and a page with a token write it.
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "ETag",
        ...headers,
      });
      res.end(req.method === "HEAD" ? undefined : body);
    };
    const json = (status, doc, headers) => send(status, TYPES[".json"], JSON.stringify(doc, null, 2) + "\n", headers);
    const fail = (err) => json(err.status, { error: err.message, ...err.extra });
    const notFound = () => send(404, "text/plain; charset=utf-8", "not in this catalog\n");
    // A file under an ETag; 304 when the client has it.
    const file = (type, body, etag, cache = "no-cache") => {
      if (etag && tag(req.headers["if-none-match"]) === etag) return send(304, type, undefined, { ETag: `"${etag}"`, "Cache-Control": cache });
      return send(200, type, body, { ...(etag && { ETag: `"${etag}"` }), "Cache-Control": cache });
    };

    let url;
    let query;
    try {
      const u = new URL(req.url, "http://catalog");
      url = decodeURIComponent(u.pathname);
      query = u.searchParams;
    } catch {
      return send(400, "text/plain; charset=utf-8", "bad path\n");
    }

    try {
      if (url === "/healthz") {
        const snap = store.snapshot;
        const health = { commit: snap?.commit ?? null, ...(store.problem && { problem: store.problem }), warnings: snap?.warnings ?? [] };
        return json(snap ? 200 : 503, health);
      }
      // /catalog is /catalog/, as a static host has it.
      if (url === base.slice(0, -1) && base !== "/") {
        res.writeHead(301, { Location: base + (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "") });
        return res.end();
      }
      if (!url.startsWith(base)) return notFound();
      const rel = url.slice(base.length);

      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, PUT, POST, DELETE",
          "Access-Control-Allow-Headers": "Authorization, Content-Type, If-Match, If-None-Match, X-Commit-Message",
          "Access-Control-Max-Age": "600",
        });
        return res.end();
      }

      // A static host has no such file: to the web app, a read-only catalog.
      if (/^api\/v2\/?$/.test(rel) && (req.method === "GET" || req.method === "HEAD")) {
        return json(200, { apiVersion: "catalog.swiss/v2", write: !!tokens, auth: "bearer" });
      }
      if (rel === "api/v2/init") return await serveInit(query);
      const api = /^api\/v2\/models(?:\/([^/]+)(?:\/(metadata|variants\/([^/]+)))?)?$/.exec(rel);
      if (api) return await serveApi(api, query);
      if (req.method !== "GET" && req.method !== "HEAD") return send(405, "text/plain; charset=utf-8", "GET only, but under api/v2/\n");
      const snap = store.snapshot;

      if (rel === "index-v2.json") return file(TYPES[".json"], snap.indexJson, snap.commit);
      if (/^models\/[^/]+\/[^/]+\.history\.json$/.test(rel)) {
        const body = snap.histories.get(rel);
        return body ? file(TYPES[".json"], body, snap.commit) : notFound();
      }
      // A commit's file never changes, so it may be kept for good.
      const raw = /^raw\/([0-9a-f]{40}|[0-9a-f]{64})\/(models\/[^/]+\/[^/]+\.yaml)$/.exec(rel);
      if (raw) {
        const body = store.repo.show(raw[1], raw[2]);
        return body ? file(TYPES[".yaml"], body, null, "public, max-age=31536000, immutable") : notFound();
      }
      if (/^models\/[^/]+\/[^/]+\.(yaml|html)$/.test(rel) && !rel.endsWith("/index.html")) {
        const oid = snap.tree.get(rel);
        // Of the YAML, the variant files alone, as the published site has them.
        const variant = snap.dirs.get(rel.split("/")[1])?.variants.some((v) => v.rel === rel);
        if (!oid || (rel.endsWith(".yaml") && !variant)) return notFound();
        const body = snap.blob(oid);
        return file(TYPES[path.extname(rel)], body, digest(body));
      }

      if (!pages) return notFound();
      const app = page("index.html");
      if (ROUTES.test(rel)) return app ? send(200, TYPES[".html"], app) : notFound();
      const body = page(rel);
      // Built assets are named by their content.
      if (body) {
        const cache = rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache";
        return send(200, TYPES[path.extname(rel)] ?? "application/octet-stream", body, { "Cache-Control": cache });
      }
      // Any other path is the app's to say it is not here.
      return app ? send(404, TYPES[".html"], app) : notFound();
    } catch (err) {
      if (err instanceof HttpError) return fail(err);
      return json(500, { error: err.message });
    }

    async function serveApi([, model, which, id], q) {
      const snap = store.snapshot;
      if (req.method === "GET" || req.method === "HEAD") {
        if (!model || (!which && !id)) return notFound();
        const dir = snap.dirs.get(model);
        const rel = id ? `models/${model}/${id}.yaml` : dir?.metaRel;
        const oid = rel && snap.tree.get(rel);
        if (!oid || (id && !dir.variants.some((v) => v.rel === rel))) return notFound();
        const body = snap.blob(oid);
        return file(TYPES[".yaml"], body, digest(body));
      }

      const op =
        req.method === "PUT" && id
          ? putVariant
          : req.method === "DELETE" && id
            ? deleteVariant
            : req.method === "PUT" && which === "metadata"
              ? putMetadata
              : req.method === "POST" && !model
                ? createModel
                : null;
      if (!op) return send(405, "text/plain; charset=utf-8", "not a method this path takes\n");
      const author = authorOf();
      if (!author) return unauthorized();

      const body = await readBody(req);
      const message = messageOf(q);
      const ask = { model, id, body, message, ifMatch: req.headers["if-match"], ifNoneMatch: req.headers["if-none-match"] };
      if (op === createModel) {
        try {
          Object.assign(ask, JSON.parse(body.toString("utf8")));
        } catch {
          throw new HttpError(400, 'want JSON {"metadata": "<metadata.yaml>", "variants": ["<variant YAML>", ...]}');
        }
        ask.message = message;
      }
      const dryRun = ["true", "1"].includes(q.get("dryRun"));
      const done = await store.write((s) => op(s, ask), { author, dryRun });
      return json(done.status, describe(done, { dryRun }), etagOf(done));
    }

    // An empty catalog is made one by committing the template's files to it:
    // catalog.yaml, naming publicUrl as its site, and the repository given.
    async function serveInit(q) {
      if (req.method === "GET" || req.method === "HEAD") {
        const snap = store.snapshot;
        return json(200, { initialized: initialized(snap), commit: snap.commit });
      }
      if (req.method !== "POST") return send(405, "text/plain; charset=utf-8", "GET or POST\n");
      const author = authorOf();
      if (!author) return unauthorized();
      const text = (await readBody(req)).toString("utf8").trim();
      let ask;
      try {
        ask = text ? JSON.parse(text) : {};
      } catch {
        throw new HttpError(400, 'want JSON {"repo": "<the repository\'s web URL>"}, or no body');
      }
      const { repo = null } = ask ?? {};
      if (repo != null && (typeof repo !== "string" || !/^https?:\/\/[^/@\s]+(\/\S*)?$/.test(repo))) {
        throw new HttpError(422, "repo: want the repository's http(s) web URL, with no credentials in it", {
          problems: [`repo: ${JSON.stringify(repo)}`],
        });
      }
      const files = templateFiles(template, { site: store.publicUrl, repo: repo?.replace(/\/+$/, "") });
      const dryRun = ["true", "1"].includes(q.get("dryRun"));
      const done = await store.write((s) => initialize(s, { files, message: messageOf(q) }), { author, dryRun });
      return json(201, { commit: done.commit, ...(dryRun && { dryRun: true }), initialized: !dryRun, files: [...done.plan.changes.keys()] });
    }

    // Who the request's token names; null when none does.
    function authorOf() {
      if (!tokens) throw new HttpError(403, "writes are off: the server has no tokens (tokensFile)");
      try {
        return tokens.who(req.headers.authorization);
      } catch (err) {
        throw new HttpError(503, `cannot read the tokens: ${err.message}`);
      }
    }

    // A token sent but in no entry is said to be, apart from none sent; the
    // server's log names its sha256's start, to match against tokensFile's
    // entries -- never the token.
    function unauthorized() {
      const sent = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? "")?.[1];
      if (sent) {
        const hash = crypto.createHash("sha256").update(sent).digest("hex");
        log.warn(`401: a token whose sha256 starts ${hash.slice(0, 12)} is in no entry of ${tokens.file}`);
      }
      const error = sent ? `that token is not in the server's tokensFile` : "send Authorization: Bearer <token>";
      return json(401, { error }, { "WWW-Authenticate": 'Bearer realm="catalog"' });
    }

    function messageOf(q) {
      return (req.headers["x-commit-message"] ?? q.get("message") ?? "").trim() || undefined;
    }
  });
}

// What a write did: its commit, and the catalog's entry for what it wrote.
function describe({ commit, plan, snapshot }, { dryRun }) {
  const out = { commit, ...(dryRun && { dryRun: true }), ...(plan.unchanged && { unchanged: true }), path: plan.rel };
  const [, model, file] = plan.rel.split("/");
  const m = snapshot.index.models.find((x) => x.name === (plan.model ?? model));
  const v = m?.variants.find((x) => x.path === plan.rel);
  if (v) Object.assign(out, { model: m.name, id: v.id, version: v.version, digest: v.digest, releaseDate: v.releaseDate, history: v.history });
  else if (file === "metadata.yaml") {
    const oid = snapshot.tree.get(plan.rel);
    Object.assign(out, { model: plan.model ?? model, digest: oid && digest(snapshot.blob(oid)) });
    if (m && plan.created) out.variants = m.variants.map(({ id, version, digest: d, path: p }) => ({ id, version, digest: d, path: p }));
  } else out.deleted = true;
  return out;
}

const etagOf = ({ plan, snapshot }) => {
  const oid = snapshot.tree.get(plan.rel);
  return oid ? { ETag: `"${digest(snapshot.blob(oid))}"` } : {};
};

module.exports = { createServer, BASE_MARK };
