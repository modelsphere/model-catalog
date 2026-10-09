"use strict";

const http = require("node:http");

// fetch() ignores HTTPS_PROXY and friends unless told to, unlike curl, helm and
// kubeconform. Honor them the same way; without a proxy variable this changes nothing.
http.setGlobalProxyFromEnv?.();

// Covers the whole body: the helm archive is ~20 MB, slow through some proxies.
async function download(url) {
  const response = await fetch(url, {signal: AbortSignal.timeout(5 * 60 * 1000)});
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

module.exports = {download};
