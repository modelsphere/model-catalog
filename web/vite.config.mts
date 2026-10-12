/// <reference types="vitest/config" />
// The frontend: one page that renders the catalog from index-v2.json -- the
// deployment recipes, the models and each model, as routes. Its backend is the catalog
// server (server/index.js): it serves index-v2.json, the variant files and their
// histories, the perf reports, and the v1 index.json with its version files.
//
//   npm run dev:site       # http://localhost:5173/model-catalog/, with a catalog
//                          # server of its own, live from models/
//   CATALOG=http://127.0.0.1:8000 npm run dev:site
//                          # another backend, e.g. a running npm run serve, or
//                          # a published site serving this version's index-v2.json
//   npm run build:site     # site/: the page and, as static files, everything the
//                          # server serves; PUBLISHED_INDEX and REWRITES say how
//                          # to treat an edited published version
//   npm run preview:site   # site/, as built
//
// site/
//   index.html                 the page; its copies below let each route
//   models.html                  load directly: GitHub Pages has no
//   variants.html                fallback for a single page app
//   models/<name>/index.html
//   404.html
//   assets/                    the page's scripts and styles
//   index-v2.json              what the page renders from, built from models/
//                              and git history
//   models/<name>/<id>.yaml    every variant file it names, and its
//   models/<name>/<id>.history.json
//   models/<name>/*.html       perf reports, copied from the repo
//   index.json                 the v1 index swiss reads, built from models/
//   models/<name>/*.yaml       every version file it names
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const { checkedIndex, writeSiteData } = require("../server/data.js");
const { createServer } = require("../server/index.js");
const { root: repo, readYaml, modelNames } = require("../hack/lib/catalog.js");

const web = import.meta.dirname;
const models = path.join(repo, "models");
const outDir = path.join(repo, "site");

// Where the site is published, from catalog.yaml: GitHub Pages serves it at
// /model-catalog/. Every route and asset is under it, in dev too.
const base = new URL(readYaml(path.join(repo, "catalog.yaml")).site).pathname;

// What the page fetches from its backend, as the backend has it: index-v2.json,
// variant files and perf reports, and the index.json the footer links. A
// model's index.html is a route of the page, not the backend's.
const fromBackend = `^${base}(?:index\\.json|index-v2\\.json|models/[^/]+/(?!index\\.html$)[^/]+\\.(?:yaml|html|history\\.json))$`;

function catalogSite(): Plugin {
  let building = false;
  let published: unknown;
  return {
    name: "catalog-site",

    // In dev, the page's data comes over HTTP from a catalog server, as it
    // does from GitHub Pages once published: CATALOG's, or one started here.
    async config(_, { command, isPreview }) {
      building = command === "build";
      if (building) {
        // The data is written after the bundle and takes most of the build;
        // that is expected, not worth a warning.
        return { build: { rolldownOptions: { checks: { pluginTimings: false } } } };
      }
      if (isPreview || process.env.VITEST) return;
      let target = process.env.CATALOG;
      if (!target) {
        const server = createServer();
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        target = `http://127.0.0.1:${server.address().port}`;
        process.once("exit", () => server.close());
      }
      console.log(`  catalog server: ${target}`);
      return {
        server: {
          proxy: {
            [fromBackend]: {
              target,
              changeOrigin: true,
              // The backend serves the catalog at its own root.
              rewrite: (url: string) => "/" + url.slice(base.length),
            },
          },
        },
      };
    },

    configureServer(server) {
      // /model-catalog is /model-catalog/, as GitHub Pages has it, rather than
      // Vite's page asking whether /model-catalog/model-catalog was meant.
      server.middlewares.use((req, res, next) => {
        const [path, query] = (req.url ?? "").split(/\?(.*)/s);
        if (path !== base.slice(0, -1)) return next();
        res.writeHead(301, { Location: base + (query ? `?${query}` : "") }).end();
      });

      // The page follows edits under models/ when its backend serves this
      // checkout.
      if (process.env.CATALOG) return;
      server.watcher.add(models);
      server.watcher.on("all", (_, file) => {
        if (file.startsWith(models + path.sep)) server.ws.send({ type: "full-reload" });
      });
    },

    // A build refuses an edit to a published version before writing anything.
    async buildStart() {
      if (building) published = await checkedIndex();
    },
    writeBundle() {
      const summary = writeSiteData(outDir, published);
      const page = fs.readFileSync(path.join(outDir, "index.html"));
      // The pages and the catalog share one tree, so a page never replaces a
      // file the catalog put there.
      for (const route of ["models.html", "variants.html", "404.html", ...modelNames().map((dir: string) => `models/${dir}/index.html`)]) {
        const file = path.join(outDir, route);
        if (fs.existsSync(file)) throw new Error(`site/${route}: the catalog has a file where a page goes`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, page);
      }
      console.log(summary);
    },
  };
}

// The repository the site is built from, for the header's GitHub link.
const repoUrl = (require("../package.json").repository.url as string).replace(/^git\+/, "").replace(/\.git$/, "");

export default defineConfig({
  root: web,
  define: { __REPO__: JSON.stringify(repoUrl) },
  base,
  // With the repository's node_modules, not a second one in web/.
  cacheDir: path.join(repo, "node_modules/.vite"),
  plugins: [react(), tailwindcss(), catalogSite()],
  resolve: { alias: { "@": path.join(web, "src") } },
  build: {
    outDir,
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        // Libraries in a chunk of their own: they change far less often than
        // the app, so browsers keep them across deploys.
        codeSplitting: { groups: [{ name: (id: string) => (id.includes("/node_modules/") ? "vendor" : null) }] },
      },
    },
  },
  test: { include: ["src/**/*.test.ts"] },
});
