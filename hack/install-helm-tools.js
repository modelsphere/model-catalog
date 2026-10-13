#!/usr/bin/env node
"use strict";

// Install the pinned helm, kubeconform and crane into .cache/bin, refusing an
// archive whose sha256 differs from config.json. crane is validate:images's,
// not helm validation's.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { root } = require("./lib/catalog");
const { download } = require("./lib/download");
const config = require("../schema/crds/config.json");

// Each tool's release archive, and the binary's path inside it.
const tools = {
  helm: (version, platform) => [`https://get.helm.sh/helm-v${version}-${platform}.tar.gz`, `${platform}/helm`],
  kubeconform: (version, platform) => [
    `https://github.com/yannh/kubeconform/releases/download/v${version}/kubeconform-${platform}.tar.gz`,
    "kubeconform",
  ],
  crane: (version, platform) => {
    const [os, arch] = platform.split("-");
    const target = `${{ darwin: "Darwin", linux: "Linux" }[os]}_${{ amd64: "x86_64", arm64: "arm64" }[arch]}`;
    return [`https://github.com/google/go-containerregistry/releases/download/v${version}/go-containerregistry_${target}.tar.gz`, "crane"];
  },
};

async function main() {
  const platform = `${process.platform}-${{ x64: "amd64", arm64: "arm64" }[process.arch]}`;
  const sums = config.toolChecksums[platform];
  if (!sums) throw new Error(`unsupported platform: ${platform}`);
  const output = path.join(root, ".cache/bin");
  fs.mkdirSync(output, { recursive: true });
  for (const [name, release] of Object.entries(tools)) {
    const version = config[`${name}Version`];
    const [url, member] = release(version, platform);
    const archive = await download(url);
    if (crypto.createHash("sha256").update(archive).digest("hex") !== sums[name]) throw new Error(`${url}: checksum mismatch`);
    const binary = execFileSync("tar", ["-xzOf", "-", member], { input: archive, maxBuffer: 512 * 1024 * 1024 });
    // Rename over the old binary: writing into one that is running fails.
    const target = path.join(output, name);
    fs.writeFileSync(`${target}.new`, binary, { mode: 0o755 });
    fs.renameSync(`${target}.new`, target);
    console.log(`Installed ${name} ${version} (${platform}, sha256:${sums[name]})`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
