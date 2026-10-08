"use strict";

const http = require("node:http");

let proxied = false;

// fetch() ignores HTTPS_PROXY and friends unless told to, unlike curl, helm and
// kubeconform. Honor them the same way; without a proxy variable this is a no-op.
function useEnvProxy() {
  if (proxied) return;
  proxied = true;
  if (typeof http.setGlobalProxyFromEnv === "function") http.setGlobalProxyFromEnv();
  else if (["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"].some((name) => process.env[name])) {
    console.warn(`Node ${process.version} cannot route fetch() through the proxy variables; set NODE_USE_ENV_PROXY=1 or upgrade Node.`);
  }
}

async function download(url) {
  useEnvProxy();
  const response = await fetch(url, {signal: AbortSignal.timeout(60000)});
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

module.exports = {download};
