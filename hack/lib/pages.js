"use strict";
// The web app's build (npm run build:web, dist/web/) serves under any path:
// it is built under BASE_MARK, and whoever serves it puts the path it serves
// it under in its place -- build:site at catalog.yaml's site path,
// catalog-server as it serves each file. catalog-server/src/server.js has its
// own copy of the mark: it is a package of its own.

const BASE_MARK = "/__catalog_base__/";

// file's bytes with base in the mark's place; only text files carry it.
function fillBase(file, body, base) {
  return /\.(?:html|js|css)$/.test(file) ? Buffer.from(body.toString("utf8").replaceAll(BASE_MARK, base)) : body;
}

module.exports = { BASE_MARK, fillBase };
