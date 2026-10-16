"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const yaml = require("yaml");
const { plan, convert, verifyTrack, verdict, hash, bytesHash, validationEntries, documentsAt } = require("./autotune-validation");

const fixtureDir = path.join(__dirname, "../fixtures/autotune/modelforge");
function v2Rows() {
  return fs
    .readdirSync(fixtureDir)
    .filter((f) => f.endsWith(".yaml") && f !== "metadata.yaml")
    .map((f) => {
      const text = fs.readFileSync(path.join(fixtureDir, f), "utf8");
      return { file: `models/modelforge/${f}`, doc: yaml.parse(text), catalog_sha256: bytesHash(text) };
    });
}
const v2Manifest = () => JSON.parse(fs.readFileSync(path.join(fixtureDir, "modelforge.validation.json"), "utf8"));
function updatedManifest(rows) {
  const m = v2Manifest();
  for (const e of m.variants) {
    const r = rows.find((r) => r.doc.id === e.variant_id);
    e.version = r.doc.version;
    e.content_sha256 = hash(r.doc);
  }
  return m;
}

test("real v2 export schedules only optimized and resolves the model sidecar", () => {
  const rows = v2Rows();
  const items = plan([], rows, (file) => {
    assert.equal(file, "models/modelforge/modelforge.validation.json");
    return v2Manifest();
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].variant.id, "sglang-tp2-h800-optimized");
  assert.equal(items[0].doc.name, "modelforge");
  assert.equal(items[0].source_run_id, 76);
  assert.equal(items[0].track, "modelforge-h800-v2");
  assert.match(convert(items[0]).command, /--chunked-prefill-size=16384/);
});

test("v2 unchanged documents need no manifest; same ID can change with a version raise", () => {
  const rows = v2Rows();
  assert.deepEqual(
    plan(rows, structuredClone(rows), () => {
      throw Error("Unexpected sidecar read");
    }),
    [],
  );
  const next = structuredClone(rows);
  const optimized = next.find((r) => r.doc.id.endsWith("-optimized"));
  optimized.doc.values.extraArgs[0] = "--chunked-prefill-size=32768";
  assert.throws(() => plan(rows, next, () => updatedManifest(next)), /version/i);
  optimized.doc.version = "0.9.0";
  assert.throws(() => plan(rows, next, () => updatedManifest(next)), /version/i);
  optimized.doc.version = "1.0.1";
  assert.equal(plan(rows, next, () => updatedManifest(next))[0].variant.version, "1.0.1");
});

test("v2 manifests bind model, file, version, parsed content and reject ambiguous entries", () => {
  const rows = v2Rows();
  for (const mutate of [
    (m) => {
      m.model = "wrong";
    },
    (m) => {
      m.variants[1].version = "9.0.0";
    },
    (m) => {
      m.variants[1].file = "../outside.yaml";
    },
    (m) => {
      m.variants[1].content_sha256 = "a".repeat(64);
    },
    (m) => {
      m.variants[1].variant_id = "unknown";
    },
    (m) => {
      m.variants.push(m.variants[1]);
    },
    (m) => {
      m.variants.pop();
    },
    (m) => {
      m.variants[1].source_run_id = 0;
    },
    (m) => {
      m.variants[1].role = "other";
    },
    (m) => {
      m.variants[1].track_slug = "../track";
    },
  ]) {
    const m = v2Manifest();
    mutate(m);
    assert.throws(() => plan([], rows, () => m));
  }
  const changed = structuredClone(rows);
  changed[1].doc.description += " changed";
  assert.throws(() => plan([], changed, () => v2Manifest()), /digest/i);
  const wrongPath = structuredClone(rows);
  wrongPath[0].file = "models/modelforge/wrong.yaml";
  assert.throws(() => plan([], wrongPath, () => v2Manifest()), /path/i);
});

test("mixed v1 and v2 planning keeps legacy rules and v2 served name", () => {
  const legacy = row("1.0.0", ["optimized"]);
  const rows = v2Rows();
  rows[1].doc.servedName = "custom-served-name";
  const items = plan([], [legacy, ...rows], (file) => (file.includes("/demo/") ? manifest(legacy) : updatedManifest(rows)));
  assert.equal(items.length, 2);
  const i = items.find((i) => i.variant.id.endsWith("-optimized"));
  verifyTrack(i, convert(i), { ...track(convert(i)), served_model_name: "custom-served-name", gpu_type: "H800" });
});

function row(version = "1.0.0", ids = ["baseline"]) {
  const result = {
    file: `models/demo/demo-${version}.yaml`,
    doc: {
      apiVersion: "catalog.swiss/v1",
      name: "demo",
      version,
      variants: ids.map((id) => ({
        id,
        engine: "sglang",
        chart: { name: "sglang", version: "0.7.1" },
        image: { repository: "registry/sglang", tag: "v1" },
        requires: { gpus: 2, gpuProduct: ["NVIDIA-H100-80GB-HBM3"] },
        values: { extraArgs: ["--tp=2", "--trust-remote-code"], model: { contextLength: "8192" } },
      })),
    },
  };
  result.catalog_sha256 = bytesHash(JSON.stringify(result.doc));
  return result;
}
function manifest(row) {
  return {
    schema_version: 1,
    catalog_file: row.file.split("/").at(-1),
    catalog_sha256: row.catalog_sha256,
    variants: row.doc.variants.map((v, i) => ({
      variant_id: v.id,
      track_slug: "demo-h100",
      source_run_id: 100 + i,
      role: v.id === "baseline" ? "baseline" : "optimized",
    })),
  };
}
const mapping = (row) => () => manifest(row);
const item = () => {
  const r = row("1.1.0", ["optimized"]);
  return { ...r, variant: r.doc.variants[0], track: "demo-h100" };
};
const track = (body) => ({
  id: 7,
  status: "open",
  served_model_name: "demo",
  gpu_type: "H100",
  images: [{ image: body.image, engine: "sglang" }],
  benchmark_config_hash: "b1",
});

test("new version copies baseline but submits only its new variant", () => {
  const old = row(),
    next = row("1.1.0", ["baseline", "optimized"]);
  const result = plan([old], [old, next], mapping(next));
  assert.deepEqual(
    result.map((r) => r.variant.id),
    ["optimized"],
  );
});
test("same ID with different launch configuration cannot bypass validation", () => {
  const old = row(),
    next = row("1.1.0");
  next.doc.variants[0].image.tag = "v2";
  assert.throws(() => plan([old], [next], mapping(next)), /assign a new id/);
});
test("explicit exported baseline is skipped even for a newly cataloged model", () => {
  const next = row("1.0.0", ["baseline", "optimized"]);
  const m = mapping(next);
  assert.deepEqual(
    plan([], [next], m).map((r) => r.variant.id),
    ["optimized"],
  );
});
test("published files are immutable and new variants require sidecar entries", () => {
  const old = row(),
    edited = structuredClone(old);
  edited.doc.variants[0].default = true;
  assert.throws(() => plan([old], [edited], mapping(old)), /immutable/);
  const next = row("1.1.0", ["optimized"]);
  assert.throws(() => plan([old], [next], () => ({ ...manifest(next), variants: [] })), /Missing validation entry/);
});
test("cosmetic changes on copied variants do not schedule GPU work", () => {
  const old = row(),
    next = row("1.1.0");
  next.doc.variants[0].description = "New description";
  assert.equal(plan([old], [next], mapping(next)).length, 0);
});
test("conversion submits repository:tag even with an exported digest and preserves runtime settings", () => {
  const i = item();
  i.variant.image.digest = `sha256:${"a".repeat(64)}`;
  i.variant.values.env = [{ name: "NCCL_DEBUG", value: "WARN" }];
  i.variant.values.volumes = [{ name: "draft", hostPath: { path: "/weights/draft" } }];
  i.variant.values.volumeMounts = [{ name: "draft", mountPath: "/draft", readOnly: true }];
  const body = convert(i);
  assert.equal(body.image, "registry/sglang:v1");
  assert.equal(i.variant.image.digest, `sha256:${"a".repeat(64)}`);
  assert.match(body.command, /--context-length=8192/);
  assert.match(body.command, /--tp=2/);
  assert.deepEqual(body.extra_env, { NCCL_DEBUG: "WARN" });
  assert.deepEqual(body.extra_volumes, { "/weights/draft": "/draft:ro" });
});
test("unrepresentable engine configuration fails rather than silently dropping fields", () => {
  const i = item();
  i.variant.values.env = [{ name: "SECRET", valueFrom: { secretKeyRef: {} } }];
  assert.throws(() => convert(i), /valueFrom/);
  delete i.variant.values.env;
  i.variant.values.command = ["custom"];
  assert.throws(() => convert(i), /Unsupported chart value/);
});
test("track must match model, repository:tag, engine and GPU", () => {
  const i = item(),
    body = convert(i),
    t = track(body);
  verifyTrack(i, body, t);
  assert.throws(() => verifyTrack(i, body, { ...t, gpu_type: "A100" }), /GPU/);
  assert.throws(() => verifyTrack(i, body, { ...t, served_model_name: "other" }), /different model/);
  assert.throws(() => verifyTrack(i, { ...body, image: "registry/sglang:other" }, t), /image/i);
  assert.throws(() => verifyTrack(i, { ...body, image: "other/sglang:v1" }, t), /image/i);
  assert.throws(() => verifyTrack(i, body, { ...t, images: [{ image: body.image, engine: "vllm" }] }), /image/i);
});
test("measured is not synonymous with passed", () => {
  for (const status of ["queued", "running"]) assert.equal(verdict({ status }), "pending");
  for (const status of ["failed", "aborted", "unknown", "measured"]) assert.equal(verdict({ status }), "failed");
  assert.equal(verdict({ status: "measured", latest_measurement: { passed: true, feasible: false } }), "failed");
  assert.equal(verdict({ status: "measured", latest_measurement: { passed: true, feasible: true } }), "passed");
});
test("identity hashing is stable across JSON key order", () => {
  assert.equal(hash({ b: 2, a: 1 }), hash({ a: 1, b: 2 }));
});
test("sidecar binds exact YAML bytes and rejects mismatches and ambiguous records", () => {
  const r = row("1.1.0", ["optimized"]),
    m = manifest(r);
  assert.equal(validationEntries(r, m).get("optimized").source_run_id, 100);
  assert.throws(() => validationEntries(r, { ...m, catalog_sha256: "a".repeat(64) }), /digest/);
  assert.throws(() => validationEntries(r, { ...m, catalog_file: "other.yaml" }), /different catalog/);
  assert.throws(() => validationEntries(r, { ...m, variants: [...m.variants, ...m.variants] }), /duplicate/);
  assert.throws(() => validationEntries(r, { ...m, schema_version: 2 }), /schema/);
  assert.throws(() => validationEntries(r, { ...m, variants: [{ ...m.variants[0], source_run_id: 0 }] }), /source run/);
});

test("CI uses existing track endpoints, polls verdict and reuses matching submission", async () => {
  const { main } = require("../validate-autotune");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-ci-test-"));
  const cwd = process.cwd();
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    fs.mkdirSync(path.join(dir, "models/demo"), { recursive: true });
    const old = row();
    fs.writeFileSync(path.join(dir, old.file), JSON.stringify(old.doc));
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    const next = row("1.1.0", ["baseline", "optimized"]);
    fs.writeFileSync(path.join(dir, next.file), JSON.stringify(next.doc));
    fs.writeFileSync(path.join(dir, next.file.replace(/\.yaml$/, ".validation.json")), JSON.stringify(manifest(next)));
    git("add", ".");
    git("commit", "-qm", "head");
    const head = git("rev-parse", "HEAD");
    process.chdir(dir);
    const env = {
      BASE_SHA: base,
      HEAD_SHA: head,
      GITHUB_REPOSITORY: "owner/catalog",
      PR_NUMBER: "3",
      GITHUB_RUN_ID: "4",
      GITHUB_TOKEN: "github-test",
      AUTOTUNE_USERNAME: "ci-user",
      AUTOTUNE_PASSWORD: "ci-pass",
      AUTOTUNE_API_URL: "https://autotune.test/api",
    };
    const statuses = [],
      submitted = [];
    let existing = [];
    let pass = true,
      boardFailure = false,
      pending = false,
      closed = false,
      aborts = 0;
    const fetcher = async (url, options) => {
      const p = new URL(url).pathname,
        body = options.body && JSON.parse(options.body);
      let result;
      if (p.endsWith("/auth/login")) {
        assert.equal(options.method, "POST");
        assert.deepEqual(body, { username: "ci-user", password: "ci-pass" });
        assert.equal(options.headers.Authorization, undefined);
        result = { access_token: "issued-service-token" };
      } else if (p.endsWith(`/statuses/${head}`)) {
        statuses.push(body.state);
        result = {};
      } else if (p.endsWith("/pulls/3")) result = { state: closed ? "closed" : "open", head: { sha: head } };
      else {
        assert.equal(options.headers.Authorization, "Bearer issued-service-token");
        assert.equal(options.headers["X-API-Key"], undefined);
        if (p.endsWith("/tracks/demo-h100"))
          result = {
            ...track(convert(item())),
            board: [{ submission_id: 10, measurement_id: 30, unranked_reason: boardFailure ? "below floor" : "" }],
          };
        else if (p.endsWith("/parse")) result = { engine: "sglang", cards: 2, warnings: [], engine_args: { tp: 2, context_length: 8192 } };
        else if (p.endsWith("/tracks/demo-h100/submissions")) {
          submitted.push(body);
          result = { ...body, id: 10, track_id: 7, status: "queued" };
          existing = [result];
        } else if (p.endsWith("/submissions/10/abort")) {
          aborts++;
          result = { id: 10, status: "aborted" };
        } else if (p.endsWith("/submissions/10"))
          result = { id: 10, status: pending ? "queued" : "measured", run_id: 20, latest_measurement: { id: 30, passed: pass, feasible: pass } };
        else if (p.endsWith("/submissions")) result = existing;
        else throw Error(`Unexpected endpoint ${p}`);
      }
      return { ok: true, status: 200, json: async () => result };
    };
    await main(env, fetcher);
    await main(env, fetcher);
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].engine_args.context_length, 8192);
    assert.equal(submitted[0].contest_api_token, undefined);
    assert.equal(statuses.at(-1), "success");
    pass = false;
    await assert.rejects(main(env, fetcher), /failed the track/);
    assert.equal(statuses.at(-1), "failure");
    pass = true;
    boardFailure = true;
    await assert.rejects(main(env, fetcher), /failed the track/);
    boardFailure = false;
    pending = true;
    await assert.rejects(main({ ...env, AUTOTUNE_TIMEOUT_MINUTES: "0.000000001" }, fetcher), /deadline exceeded/);
    assert.equal(aborts, 0, "expired deadline is detected before a reused submission needs cancellation");
    const timedOut = JSON.parse(fs.readFileSync("artifacts/autotune-validation/results.json", "utf8"));
    assert.equal(timedOut.reports[0].result, "timed_out");
    pending = false;
    closed = true;
    await assert.rejects(main(env, fetcher), /PR closed/);
    assert.equal(submitted.length, 1);
    closed = false;
    await main({ ...env, GITHUB_RUN_ATTEMPT: "2" }, fetcher);
    assert.equal(submitted.length, 2, "Explicit rerun starts a fresh attempt");
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("v2 export flows from Git blobs through main and reports the measurement run", async () => {
  const { main } = require("../validate-autotune");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-v2-ci-"));
  const cwd = process.cwd();
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  try {
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    const legacy = row();
    fs.mkdirSync(path.join(dir, "models/demo"), { recursive: true });
    fs.writeFileSync(path.join(dir, legacy.file), JSON.stringify(legacy.doc));
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    fs.cpSync(fixtureDir, path.join(dir, "models/modelforge"), { recursive: true });
    git("add", ".");
    git("commit", "-qm", "export");
    const head = git("rev-parse", "HEAD");
    process.chdir(dir);
    assert.equal(documentsAt(head).length, 3);
    // Serialization changes do not invalidate a v2 content hash.
    const optimized = v2Rows()[1];
    fs.writeFileSync(optimized.file, "# formatted differently\n" + JSON.stringify(optimized.doc, null, 2));
    git("add", ".");
    git("commit", "-qm", "format");
    const formatted = git("rev-parse", "HEAD");
    const env = {
      BASE_SHA: base,
      HEAD_SHA: formatted,
      GITHUB_REPOSITORY: "owner/catalog",
      PR_NUMBER: "3",
      GITHUB_RUN_ID: "4",
      GITHUB_TOKEN: "github-test",
      AUTOTUNE_USERNAME: "ci-user",
      AUTOTUNE_PASSWORD: "ci-pass",
      AUTOTUNE_API_URL: "https://autotune.test/api",
    };
    const statuses = [],
      submissions = [];
    const image = `${optimized.doc.image.repository}:${optimized.doc.image.tag}`;
    await main(env, async (url, options) => {
      const p = new URL(url).pathname;
      let body;
      if (p.endsWith("/auth/login")) {
        assert.equal(options.method, "POST");
        assert.deepEqual(JSON.parse(options.body), { username: "ci-user", password: "ci-pass" });
        assert.equal(options.headers.Authorization, undefined);
        body = { access_token: "issued-service-token" };
      } else if (new URL(url).host === "autotune.test") {
        assert.equal(options.headers.Authorization, "Bearer issued-service-token");
        assert.equal(options.headers["X-API-Key"], undefined);
      }
      if (p.endsWith("/auth/login")) {
        // Login has no existing bearer token.
      } else if (p.endsWith("/statuses/" + formatted)) {
        statuses.push(JSON.parse(options.body).state);
        body = {};
      } else if (p.endsWith("/pulls/3")) body = { state: "open", head: { sha: formatted } };
      else if (p.endsWith("/tracks/modelforge-h800-v2"))
        body = {
          id: 2,
          status: "open",
          served_model_name: "modelforge",
          gpu_type: "H800",
          images: [{ image, engine: "sglang" }],
          benchmark_config_hash: "frozen",
          board: [{ submission_id: 10, measurement_id: 30 }],
        };
      else if (p.endsWith("/parse")) {
        assert.match(JSON.parse(options.body).command, /--chunked-prefill-size=16384/);
        body = { engine: "sglang", cards: 2, warnings: [], engine_args: { tp: "2", chunked_prefill_size: "16384" } };
      } else if (p.endsWith("/tracks/modelforge-h800-v2/submissions")) {
        submissions.push(JSON.parse(options.body));
        body = { id: 10, status: "queued" };
      } else if (p.endsWith("/submissions/10"))
        body = { id: 10, status: "measured", run_id: null, latest_measurement: { id: 30, run_id: 80, passed: true, feasible: true } };
      else if (p.endsWith("/submissions")) body = [];
      else throw Error("Unexpected endpoint: " + p);
      return { ok: true, status: 200, json: async () => body };
    });
    assert.deepEqual(statuses, ["pending", "success"]);
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0].image, image);
    assert.match(submissions[0].notes, /source run 76/);
    const results = JSON.parse(fs.readFileSync("artifacts/autotune-validation/results.json", "utf8"));
    assert.equal(results.reports[0].run_id, 80);
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("polling retries transient errors, enforces the deadline, and records final failures", async () => {
  const { main } = require("../validate-autotune");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-poll-ci-"));
  const cwd = process.cwd();
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  const realNow = Date.now;
  try {
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("commit", "--allow-empty", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    fs.cpSync(fixtureDir, path.join(dir, "models/modelforge"), { recursive: true });
    git("add", ".");
    git("commit", "-qm", "head");
    const head = git("rev-parse", "HEAD");
    process.chdir(dir);
    const v = yaml.parse(fs.readFileSync(path.join(fixtureDir, "sglang-tp2-h800-optimized.yaml"), "utf8"));
    const image = `${v.image.repository}:${v.image.tag}`;
    const run = async (scenario, attempt) => {
      let now = realNow(),
        polls = 0,
        posts = 0,
        aborts = 0,
        trackReads = 0;
      const states = [];
      Date.now = () => now;
      const env = {
        BASE_SHA: base,
        HEAD_SHA: head,
        GITHUB_REPOSITORY: "owner/catalog",
        PR_NUMBER: "3",
        GITHUB_RUN_ID: "4",
        GITHUB_RUN_ATTEMPT: String(attempt),
        GITHUB_TOKEN: "github-test",
        AUTOTUNE_USERNAME: "ci-user",
        AUTOTUNE_PASSWORD: "ci-pass",
        AUTOTUNE_API_URL: "https://autotune.test/api",
        AUTOTUNE_TIMEOUT_MINUTES: "1",
      };
      const fetcher = async (url, options) => {
        const p = new URL(url).pathname;
        let result;
        if (p.endsWith("/auth/login")) {
          assert.deepEqual(JSON.parse(options.body), { username: "ci-user", password: "ci-pass" });
          assert.equal(options.headers.Authorization, undefined);
          result = { access_token: "issued-service-token" };
        } else if (new URL(url).host === "autotune.test") {
          assert.equal(options.headers.Authorization, "Bearer issued-service-token");
          assert.equal(options.headers["X-API-Key"], undefined);
        }
        if (p.endsWith("/auth/login")) {
          // Login has no existing bearer token.
        } else if (p.endsWith(`/statuses/${head}`)) {
          states.push(JSON.parse(options.body).state);
          result = {};
        } else if (p.endsWith("/pulls/3")) result = { state: "open", head: { sha: head } };
        else if (p.endsWith("/tracks/modelforge-h800-v2")) {
          trackReads++;
          result = {
            id: 2,
            status: "open",
            served_model_name: "modelforge",
            gpu_type: "H800",
            images: [{ image, engine: "sglang" }],
            benchmark_config_hash: scenario === "benchmark-changed" && trackReads > 1 ? "changed" : "frozen",
            board: [{ submission_id: 10, measurement_id: 30 }],
          };
        } else if (p.endsWith("/parse")) {
          if (scenario === "deadline-before-submit") now += 60001;
          result = { engine: "sglang", cards: 2, warnings: [], engine_args: { tp: "2" } };
        } else if (p.endsWith("/tracks/modelforge-h800-v2/submissions")) {
          posts++;
          result = { id: 10, status: "queued" };
          if (scenario === "deadline-during-poll") now += 60001;
        } else if (p.endsWith("/submissions/10/abort")) {
          aborts++;
          result = { id: 10, status: "aborted" };
        } else if (p.endsWith("/submissions/10")) {
          polls++;
          if (scenario === "transient-503" && polls === 1) return { ok: false, status: 503 };
          if (scenario === "deadline-during-poll") now += 60001;
          result = { id: 10, status: "measured", run_id: 20, latest_measurement: { id: 30, run_id: 30, passed: true, feasible: true } };
        } else if (p.endsWith("/submissions")) result = [];
        else throw Error(`Unexpected endpoint ${p}`);
        return { ok: true, status: 200, json: async () => result };
      };
      let error;
      try {
        await main(env, fetcher);
      } catch (e) {
        error = e;
      }
      const report = JSON.parse(fs.readFileSync("artifacts/autotune-validation/results.json", "utf8"));
      return { error, states, posts, polls, aborts, row: report.reports[0] };
    };

    const recovered = await run("transient-503", 1);
    assert.equal(recovered.error, undefined);
    assert.equal(recovered.polls, 2);
    assert.equal(recovered.aborts, 0);
    assert.equal(recovered.row.result, "passed");

    const before = await run("deadline-before-submit", 2);
    assert.match(before.error.message, /deadline/i);
    assert.equal(before.posts, 0, "expired validation must not create a submission");

    const during = await run("deadline-during-poll", 3);
    assert.match(during.error.message, /deadline/i);
    assert.equal(during.row.result, "timed_out");
    assert.ok(during.row.failure_reason);

    const changed = await run("benchmark-changed", 4);
    assert.equal(changed.states.at(-1), "failure");
    assert.equal(changed.row.result, "failed");
    assert.ok(changed.row.failure_reason);
  } finally {
    Date.now = realNow;
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
