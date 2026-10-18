/// <reference types="vitest/config" />
// The frontend: one page that renders the catalog from index-v2.json -- the
// deployment recipes, the models and each model, as routes -- and the same
// routes as the <model-catalog> element (src/element.tsx), for another page.
// One build of both serves any catalog, under any path; editing turns on
// where the server says it takes writes (src/lib/edit.ts).
//
//   npm run dev:site       # http://localhost:5173/model-catalog/, with a catalog
//                          # server of its own, live from models/
//   CATALOG=http://127.0.0.1:8000 npm run dev:site
//                          # another backend: a running npm run serve, a
//                          # catalog-server (with editing), or a published site
//   npm run build:web      # dist/web/: the pages and the element
//   npm run build:site     # site/: dist/web/ for GitHub Pages, with the catalog
//                          # beside it (hack/build-site.js)
//   npm run preview:site   # site/, as built
//
// dist/web/
//   index.html                 the page, for every route
//   assets/                    its scripts, styles and fonts
//   logo.png, icon.png         the header's logo and the site icon, from asserts/
//   element/model-catalog.js   the element: one file, its styles and fonts
//                              inlined, so a page loads it from wherever the
//                              catalog is, with nothing beside it
//
// Built, every path in it starts with BASE_MARK (hack/lib/pages.js), which
// whoever serves it fills in.
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { createServer } = require("../server/index.js");
const { root: repo, readYaml } = require("../hack/lib/catalog.js");
const { BASE_MARK } = require("../hack/lib/pages.js");

const web = import.meta.dirname;
const models = path.join(repo, "models");
const outDir = path.join(repo, "dist/web");

// Where the site is published, from catalog.yaml: GitHub Pages serves it at
// /model-catalog/. In dev and preview, every route and asset is under it.
const siteBase = new URL(readYaml(path.join(repo, "catalog.yaml")).site).pathname;

// What the page fetches from its backend, as the backend has it: index-v2.json,
// variant files and perf reports, the index.json the footer links, and the
// write API of a backend that has one. A model's index.html is a route of the
// page, not the backend's.
const fromBackend = (base: string) =>
  `^${base}(?:api/v2(?:/.*)?|index\\.json|index-v2\\.json|models/[^/]+/(?!index\\.html$)[^/]+\\.(?:yaml|html|history\\.json))(?:\\?.*)?$`;

// In dev, the page's data comes over HTTP from a catalog server, as it does
// from GitHub Pages once published: CATALOG's -- its path, if it has one, is
// where the catalog is on it -- or one started here, of this checkout.
function catalogBackend(base: string): Plugin {
  return {
    name: "catalog-backend",
    apply: "serve",

    async config(_, { isPreview }) {
      if (isPreview || process.env.VITEST) return;
      let target = process.env.CATALOG;
      if (!target) {
        const server = createServer();
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        target = `http://127.0.0.1:${server.address().port}`;
        process.once("exit", () => server.close());
      }
      console.log(`  catalog server: ${target}`);
      const at = new URL(target).pathname.replace(/\/*$/, "/");
      return {
        server: {
          proxy: {
            [fromBackend(base)]: {
              target: new URL(target).origin,
              changeOrigin: true,
              rewrite: (url: string) => at + url.slice(base.length),
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
  };
}

// The repository the site is built from, for the header's GitHub link.
const repoUrl = (require("../package.json").repository.url as string).replace(/^git\+/, "").replace(/\.git$/, "");

export default defineConfig(({ command, isPreview }) => {
  const base = command === "build" ? BASE_MARK : siteBase;
  return {
    root: web,
    define: { __REPO__: JSON.stringify(repoUrl) },
    base,
    publicDir: path.join(repo, "asserts"),
    // With the repository's node_modules, not a second one in web/.
    cacheDir: path.join(repo, "node_modules/.vite"),
    plugins: [react(), tailwindcss(), catalogBackend(base)],
    resolve: { alias: { "@": path.join(web, "src") } },
    environments: {
      // The page. Preview serves the site, as build:site assembles it.
      client: {
        build: {
          outDir: isPreview ? path.join(repo, "site") : outDir,
          emptyOutDir: true,
          rolldownOptions: {
            output: {
              // Libraries in a chunk of their own: they change far less often
              // than the app, so browsers keep them across deploys.
              codeSplitting: { groups: [{ name: (id: string) => (id.includes("/node_modules/") ? "vendor" : null), debugName: "vendor" }] },
            },
          },
        },
      },
      // The element: the whole program in one file, React included.
      element: {
        consumer: "client",
        define: { __REPO__: JSON.stringify(repoUrl), "process.env.NODE_ENV": JSON.stringify("production") },
        build: {
          outDir: path.join(outDir, "element"),
          emptyOutDir: true,
          copyPublicDir: false,
          // Fonts and images inlined: the file is the element.
          assetsInlineLimit: () => true,
          // A library build keeps its whitespace by default, for a bundler to
          // minify; nothing bundles this one again.
          minify: true,
          lib: { entry: path.join(web, "src/element.tsx"), formats: ["es"], fileName: () => "model-catalog.js" },
        },
      },
    },
    builder: {
      // The page first: it empties dist/web/, and the element goes inside.
      async buildApp(builder) {
        await builder.build(builder.environments.client);
        await builder.build(builder.environments.element);
      },
    },
    test: { include: ["src/**/*.test.ts"] },
  };
});
