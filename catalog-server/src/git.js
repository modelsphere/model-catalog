"use strict";
// The catalog's repository, through git plumbing alone. The server reads every
// file it serves from a commit, and writes a change as a new commit built in a
// private index, so there is no working tree: what it serves is always one
// commit, never a half-written checkout.
//
// The repository is a local directory, bare, and the catalog itself: the
// server owns one branch of it. Anyone may push to that branch too (it is a
// git repository like any other); the server serves what it finds there.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

class GitError extends Error {}

function run(dir, args, { input, env } = {}) {
  const r = spawnSync("git", args, { cwd: dir, input, env: { ...process.env, ...env }, maxBuffer: 1 << 30 });
  if (r.error) throw new GitError(`git: ${r.error.message}`);
  if (r.status !== 0) throw new GitError(`git ${args[0]}: ${r.stderr.toString().trim()}`);
  return r.stdout;
}

const text = (dir, args, opts) => run(dir, args, opts).toString("utf8").trim();

// The blobs at specs (<commit>:<path>, or object ids), in one git call.
function blobs(dir, specs) {
  if (specs.length === 0) return [];
  const out = run(dir, ["cat-file", "--batch"], { input: specs.join("\n") + "\n" });
  const bodies = [];
  let at = 0;
  for (const spec of specs) {
    const nl = out.indexOf(10, at);
    const header = out.toString("utf8", at, nl);
    if (!/ blob \d+$/.test(header)) throw new GitError(`git cat-file ${spec}: ${header}`);
    const size = Number(header.split(" ")[2]);
    bodies.push(out.subarray(nl + 1, nl + 1 + size));
    at = nl + 1 + size + 1;
  }
  return bodies;
}

const DEFAULT_COMMITTER = { name: "catalog-server", email: "catalog-server@localhost" };

// A directory with nothing in it, or none at all: no repository yet.
const isEmpty = (dir) => !fs.existsSync(dir) || fs.readdirSync(dir).length === 0;

class Repo {
  // dir, the catalog's bare repository; branch, the branch served (null until
  // the repository names it); committer, who commits ({name, email}) --
  // whoever asked is the author. made: whether dir holds the repository yet.
  constructor({ dir, branch = null, committer = DEFAULT_COMMITTER, made = true }) {
    Object.assign(this, { dir, branch, committer, made });
  }

  get ref() {
    return `refs/heads/${this.branch}`;
  }

  // The repository at dir. A missing or empty directory is left as it is: a
  // catalog not made yet, served empty, until setting it up makes the
  // repository (init, from POST api/v2/init).
  static open({ dir, branch = null, committer }) {
    const repo = new Repo({ dir, branch, committer, made: false });
    if (!isEmpty(dir)) repo.adopt();
    return repo;
  }

  // Takes the repository at dir as the catalog's, checked, on its branch.
  adopt() {
    const dir = this.dir;
    if (spawnSync("git", ["rev-parse", "--git-dir"], { cwd: dir }).status !== 0) {
      throw new GitError(`${dir}: not empty and not a git repository -- will not make one there`);
    }
    if (text(dir, ["rev-parse", "--is-bare-repository"]) !== "true") {
      throw new GitError(`${dir}: not a bare repository -- the server moves its branch with no working tree to keep up; use git clone --bare`);
    }
    // Release dates and histories come from all of it.
    if (text(dir, ["rev-parse", "--is-shallow-repository"]) === "true") {
      throw new GitError(`${dir}: a shallow clone -- histories need all of it (git fetch --unshallow)`);
    }
    this.branch ??= text(dir, ["symbolic-ref", "--short", "HEAD"]);
    run(dir, ["symbolic-ref", "HEAD", this.ref]);
    this.made = true;
  }

  // Makes the repository at dir, on branch (git's default name when unset):
  // the first thing setting the catalog up does. One made there meanwhile is
  // taken as it is.
  init() {
    if (this.made) return;
    if (isEmpty(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
      run(this.dir, ["init", "--quiet", "--bare", ...(this.branch ? ["--initial-branch", this.branch] : [])]);
    }
    this.adopt();
  }

  // The commit served, or null for a catalog with none yet. A repository it
  // cannot read throws: that is not an empty catalog -- a volume gone is not
  // a catalog to start again.
  tip() {
    if (!this.made) {
      if (isEmpty(this.dir)) return null;
      // Someone made one there meanwhile: it is the catalog.
      this.adopt();
    }
    const r = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${this.ref}^{commit}`], { cwd: this.dir });
    if (r.status === 0) return r.stdout.toString().trim();
    if (r.status === 1) return null;
    throw new GitError(`git rev-parse ${this.ref}: ${r.error?.message ?? r.stderr.toString().trim()}`);
  }

  // Moves the branch from was to commit, only if it is still at was; false
  // when someone else moved it first (a push to dir). was null: the branch
  // must not exist.
  move(commit, was) {
    const r = spawnSync("git", ["update-ref", "-m", "catalog-server", this.ref, commit, was ?? ""], { cwd: this.dir });
    return r.status === 0;
  }

  // Every file under models/ and catalog.yaml at commit: path -> object id.
  tree(commit) {
    const files = new Map();
    if (!commit) return files;
    const out = run(this.dir, ["ls-tree", "-r", "-z", "--full-tree", commit, "--", "catalog.yaml", "models"]).toString("utf8");
    for (const entry of out.split("\0").filter(Boolean)) {
      const tab = entry.indexOf("\t");
      const [mode, type, oid] = entry.slice(0, tab).split(" ");
      if (type === "blob" && mode !== "120000") files.set(entry.slice(tab + 1), oid);
    }
    return files;
  }

  blobs(specs) {
    return blobs(this.dir, specs);
  }

  // A commit as git show has it -- who, when, why, and what it changed -- or
  // null when there is no such commit.
  commitText(commit) {
    if (!this.made) return null;
    const r = spawnSync("git", ["show", "--no-color", "--format=fuller", "--stat", "--patch", `${commit}^{commit}`, "--"], {
      cwd: this.dir,
      maxBuffer: 1 << 28,
    });
    return r.status === 0 ? r.stdout : null;
  }

  // The file at path in commit, or null when it has none.
  show(commit, file) {
    const r = spawnSync("git", ["cat-file", "blob", `${commit}:${file}`], { cwd: this.dir, maxBuffer: 1 << 28 });
    return r.status === 0 ? r.stdout : null;
  }

  // A commit on parent (null: the first) with changes (path -> bytes, null
  // deletes), by author ({name, email}); null when it changes nothing. The
  // branch does not move: the caller decides whether it does.
  commit({ parent, changes, message, author }) {
    const index = path.join(os.tmpdir(), `catalog-server-${process.pid}-${Math.random().toString(36).slice(2)}.index`);
    const env = { GIT_INDEX_FILE: index };
    try {
      run(this.dir, parent ? ["read-tree", parent] : ["read-tree", "--empty"], { env });
      const lines = [...changes].map(([file, body]) => {
        if (body === null) return `0 ${"0".repeat(40)}\t${file}`;
        const oid = text(this.dir, ["hash-object", "-w", "--stdin"], { input: body });
        return `100644 ${oid}\t${file}`;
      });
      run(this.dir, ["update-index", "--index-info"], { env, input: lines.join("\n") + "\n" });
      const tree = text(this.dir, ["write-tree"], { env });
      if (parent && tree === text(this.dir, ["rev-parse", `${parent}^{tree}`])) return null;
      return text(this.dir, ["commit-tree", "--no-gpg-sign", tree, ...(parent ? ["-p", parent] : []), "-F", "-"], {
        input: message.endsWith("\n") ? message : message + "\n",
        env: {
          GIT_AUTHOR_NAME: author.name,
          GIT_AUTHOR_EMAIL: author.email,
          GIT_COMMITTER_NAME: this.committer.name,
          GIT_COMMITTER_EMAIL: this.committer.email,
        },
      });
    } finally {
      fs.rmSync(index, { force: true });
    }
  }
}

module.exports = { Repo, GitError, run, text };
