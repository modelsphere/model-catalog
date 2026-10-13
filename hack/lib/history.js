"use strict";
// The git history v2's date versions and history.json are derived from.

const { spawnSync } = require("child_process");

function git(root, args, input) {
  const r = spawnSync("git", args, { cwd: root, input, maxBuffer: 1 << 30 });
  if (r.error) throw new Error(`git: ${r.error.message} -- date versions are derived from git history`);
  if (r.status !== 0) throw new Error(`git ${args[0]}: ${r.stderr.toString().trim()}`);
  return r.stdout;
}

function blobs(root, specs) {
  if (specs.length === 0) return [];
  const out = git(root, ["cat-file", "--batch"], specs.join("\n") + "\n");
  const bodies = [];
  let at = 0;
  for (const spec of specs) {
    const nl = out.indexOf(10, at);
    const header = out.toString("utf8", at, nl);
    const size = Number(header.split(" ")[2]);
    if (!/ blob \d+$/.test(header)) throw new Error(`git cat-file ${spec}: ${header}`);
    bodies.push(out.subarray(nl + 1, nl + 1 + size));
    at = nl + 1 + size + 1;
  }
  return bodies;
}

// Changes to models/<name>/*.yaml on HEAD's first-parent chain, oldest first:
// path -> [{commit, date, subject, deleted, bytes}], date the commit's UTC
// committer date (YYYY-MM-DD). last is the last commit touching models/ or
// catalog.yaml.
function fileHistory(root) {
  if (git(root, ["rev-parse", "--is-shallow-repository"]).toString().trim() === "true") {
    throw new Error("a shallow clone: date versions need the full history (actions/checkout with fetch-depth: 0, or git fetch --unshallow)");
  }
  const files = new Map();
  if (spawnSync("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: root }).status !== 0) return { files, last: null };
  const log = git(root, [
    "log",
    "--reverse",
    "--first-parent",
    "--diff-merges=first-parent",
    "--no-renames",
    "--name-status",
    "-z",
    "--format=%x1e%H%x1f%ct%x1f%s",
    "--",
    "models",
    "catalog.yaml",
  ]).toString("utf8");
  let last = null;
  const pending = [];
  for (const record of log.split("\x1e").slice(1)) {
    const end = record.indexOf("\0");
    const [commit, time, subject] = record.slice(0, end).split("\x1f");
    const date = new Date(Number(time) * 1000).toISOString().slice(0, 10);
    last = commit;
    const fields = record
      .slice(end + 1)
      .replace(/^\n/, "")
      .split("\0");
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const [status, file] = [fields[i], fields[i + 1]];
      if (!/^models\/[^/]+\/[^/]+\.yaml$/.test(file) || file.endsWith("/metadata.yaml")) continue;
      const change = { commit, date, subject, deleted: status === "D", bytes: null };
      if (!files.has(file)) files.set(file, []);
      files.get(file).push(change);
      if (!change.deleted) pending.push([change, `${commit}:${file}`]);
    }
  }
  const bodies = blobs(
    root,
    pending.map(([, spec]) => spec),
  );
  pending.forEach(([change], i) => (change.bytes = bodies[i]));
  return { files, last };
}

module.exports = { fileHistory };
