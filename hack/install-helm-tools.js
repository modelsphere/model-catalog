#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {execFileSync} = require("node:child_process");
const {root} = require("./lib/catalog");
const config = require("../schema/helm/config.json");

async function main() {
  const platform = `${process.platform}-${{x64: "amd64", arm64: "arm64"}[process.arch]}`;
  const sums = config.toolChecksums[platform];
  if (!sums) throw new Error(`unsupported platform: ${platform}`);
  const output = path.join(root, ".cache/helm-validation/bin");
  fs.mkdirSync(output, {recursive: true});
  for (const name of ["helm", "kubeconform"]) {
    const version = config[`${name}Version`];
    const archive = name === "helm" ? `helm-v${version}-${platform}.tar.gz` : `kubeconform-${platform}.tar.gz`;
    const url = name === "helm" ? `https://get.helm.sh/${archive}` :
      `https://github.com/yannh/kubeconform/releases/download/v${version}/${archive}`;
    const response = await fetch(url, {signal: AbortSignal.timeout(60000)});
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== sums[name]) {
      throw new Error(`${archive}: checksum mismatch`);
    }
    const temp = fs.mkdtempSync(path.join(output, ".install-"));
    try {
      const archivePath = path.join(temp, archive);
      fs.writeFileSync(archivePath, bytes);
      const member = name === "helm" ? `${platform}/helm` : "kubeconform";
      execFileSync("tar", ["-xzf", archivePath, "-C", temp, member]);
      fs.copyFileSync(path.join(temp, member), path.join(output, name));
      fs.chmodSync(path.join(output, name), 0o755);
    } finally {
      fs.rmSync(temp, {recursive: true, force: true});
    }
    console.log(`Installed ${name} ${version} (${platform}, sha256:${sums[name]})`);
  }
}

main().catch((err) => {console.error(err.message); process.exitCode = 1;});
