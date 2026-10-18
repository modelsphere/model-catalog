"use strict";
// The catalog the server serves, and the one way it changes. It holds the
// snapshot of the branch's tip (catalog.js) that every read is answered from,
// and runs writes and syncs one at a time:
//
//   write  plan the change on the tip (writes.js), commit it, check the
//          catalog at that commit builds, move the branch, and serve it --
//          all or nothing
//   sync   serve the tip, when someone else moved it: a push to the
//          repository itself
//
// A snapshot is swapped in whole, so a read sees one commit or the next,
// never a mix.

const { buildSnapshot } = require("./catalog");
const { HttpError } = require("./writes");

class Store {
  constructor({ repo, publicUrl = null, log = console }) {
    Object.assign(this, { repo, publicUrl, log });
    this.queue = Promise.resolve();
    this.snapshot = null;
    // What went wrong last, for /healthz: a tip that does not build. The
    // snapshot served stays the last one that did.
    this.problem = null;
  }

  build(commit) {
    return buildSnapshot(this.repo, commit, { publicUrl: this.publicUrl });
  }

  // One at a time, in order: a write never plans on a tip another is moving.
  exclusive(task) {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }

  async start() {
    await this.exclusive(() => this.catchUp());
    if (!this.snapshot) throw new Error(this.problem);
    return this;
  }

  // Serves the branch's tip. Throws only when write is set: a write must not
  // plan on a tip it cannot read.
  async catchUp({ write = false } = {}) {
    try {
      const tip = this.repo.tip();
      if (!this.snapshot || this.snapshot.commit !== tip) {
        const snap = this.build(tip);
        if (this.snapshot && tip) this.log.log(`catalog at ${tip.slice(0, 12)}`);
        for (const w of snap.warnings) if (!this.snapshot?.warnings.includes(w)) this.log.warn(w);
        this.snapshot = snap;
      }
      this.problem = null;
    } catch (err) {
      this.problem = err.message;
      this.log.warn(`sync: ${this.problem}`);
      if (write) throw new HttpError(503, `cannot read the catalog: ${this.problem}`);
    }
  }

  sync() {
    return this.exclusive(() => this.catchUp());
  }

  // Runs plan (snapshot -> what writes.js returns) on the tip and commits it
  // as author. Resolves to {status, commit, plan, snapshot}: the catalog as
  // the write left it -- or, for a dry run, would leave it.
  write(plan, { author, dryRun = false }) {
    return this.exclusive(async () => {
      await this.catchUp({ write: true });
      const base = this.snapshot;
      const p = plan(base);
      if (p.unchanged) return { status: 200, commit: base.commit, plan: p, snapshot: base };
      // No repository yet: only setting the catalog up gets here (the others
      // need its catalog.yaml), and it makes one -- not for a dry run.
      if (!this.repo.made) {
        if (dryRun) return { status: p.created ? 201 : 200, commit: null, plan: p, snapshot: base };
        this.repo.init();
      }
      const commit = this.repo.commit({ parent: base.commit, changes: p.changes, message: p.message, author });
      if (!commit) return { status: 200, commit: base.commit, plan: { ...p, unchanged: true }, snapshot: base };
      const snapshot = this.build(commit);
      const status = p.created ? 201 : 200;
      // The commit object stays behind, unreferenced: git gc takes it.
      if (dryRun) return { status, commit: null, plan: p, snapshot };
      if (!this.repo.move(commit, base.commit)) {
        // Someone pushed to the repository meanwhile.
        throw new HttpError(409, "the catalog moved while this was written: read it again and retry");
      }
      this.snapshot = snapshot;
      this.log.log(`${commit.slice(0, 12)} ${p.message.split("\n")[0]} (${author.name})`);
      return { status, commit, plan: p, snapshot };
    });
  }

  // Looks for a moved tip every interval ms; returns a function that stops it.
  follow(interval) {
    let timer;
    let stopped = false;
    const round = async () => {
      await this.sync();
      if (!stopped) timer = setTimeout(round, interval);
    };
    timer = setTimeout(round, interval);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }
}

module.exports = { Store };
