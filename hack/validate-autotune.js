#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { check, hash, readAt, documentsAt, plan, convert, verifyTrack, verdict } = require("./lib/autotune-validation");

// No PR code runs here. Only v1/v2 model YAML and validation sidecars are read from its commit.
async function main(env = process.env, fetcher = fetch) {
  const required = (key) => {
    check(env[key], `Missing ${key}`);
    return env[key];
  };
  const head = required("HEAD_SHA");
  const base = required("BASE_SHA");
  check(/^[a-f0-9]{40}$/.test(head) && /^[a-f0-9]{40}$/.test(base), "Invalid commit SHA");
  const repo = required("GITHUB_REPOSITORY");
  const pr = required("PR_NUMBER");
  check(/^[\w.-]+\/[\w.-]+$/.test(repo) && /^\d+$/.test(pr), "Invalid PR identity");
  const runUrl = `${env.GITHUB_SERVER_URL || "https://github.com"}/${repo}/actions/runs/${required("GITHUB_RUN_ID")}`;
  const ghBase = env.GITHUB_API_URL || "https://api.github.com";
  const reports = [];
  const active = new Set();
  let stopping = false;
  let api;
  let deadline = Infinity;
  let currentReport;
  const request = async (url, headers, method = "GET", body) => {
    const response = await fetcher(url, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: { ...headers, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // Do not print remote response bodies: they can contain private runtime details.
    if (!response.ok) {
      const error = new Error(`${method} ${new URL(url).pathname}: HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.status === 204 ? null : response.json();
  };
  const gh = (path, method, body) =>
    request(
      `${ghBase}/repos/${repo}${path}`,
      { Authorization: `Bearer ${required("GITHUB_TOKEN")}`, Accept: "application/vnd.github+json" },
      method,
      body,
    );
  const status = (state, description) =>
    gh(`/statuses/${head}`, "POST", {
      state,
      context: "autotune/track-validation",
      description,
      target_url: runUrl,
    });
  const current = async () => {
    const pull = await gh(`/pulls/${pr}`);
    check(pull.state === "open" && pull.head.sha === head, "PR closed or replaced by a newer commit");
    check(!stopping, "Workflow cancelled");
  };
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const abort = async (id) => {
    const sub = await api(`/submissions/${id}`);
    if (verdict(sub) === "pending") await api(`/submissions/${id}/abort`, "POST", {});
    active.delete(id);
  };
  const pollSubmission = async (id) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      check(!stopping, "Workflow cancelled");
      check(Date.now() < deadline, "Validation deadline exceeded (including queue time)");
      try {
        const submission = await api(`/submissions/${id}`);
        check(Date.now() < deadline, "Validation deadline exceeded (including queue time)");
        return submission;
      } catch (error) {
        if (error.message.includes("Validation deadline exceeded") || error.message === "Workflow cancelled") throw error;
        const retryable = error.status === 429 || error.status >= 500 || error.name === "TypeError";
        if (!retryable || attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** attempt, 5000)));
      }
    }
  };
  try {
    await status("pending", "Checking new variants on their original tracks");
    await current();
    const items = plan(documentsAt(base), documentsAt(head), (file) => JSON.parse(readAt(head, file)));
    if (items.length) {
      const apiBase = required("AUTOTUNE_API_URL").replace(/\/$/, "");
      check(/^https?:\/\//.test(apiBase), "AUTOTUNE_API_URL must be an HTTP(S) URL ending in /api");
      const login = await request(`${apiBase}/auth/login`, {}, "POST", {
        username: required("AUTOTUNE_USERNAME"),
        password: required("AUTOTUNE_PASSWORD"),
      });
      check(typeof login?.access_token === "string" && login.access_token.length > 0, "AutoTune login response is missing access_token");
      const token = login.access_token;
      api = (path, method, body) => request(`${apiBase}/baseline-hub${path}`, { Authorization: `Bearer ${token}` }, method, body);
      const prefix = `catalog-ci:${repo}:pr:${pr}:`;
      const attempt = env.GITHUB_RUN_ATTEMPT || "1";
      const limit = Number(env.AUTOTUNE_TIMEOUT_MINUTES || 240);
      check(Number.isFinite(limit) && limit > 0 && limit <= 300, "Timeout must be 1–300 minutes");
      deadline = Date.now() + limit * 60000;
      // Resolve and validate ALL configs before spending GPU time.
      const prepared = [];
      for (const item of items) {
        const body = convert(item);
        const track = await api(`/tracks/${encodeURIComponent(item.track)}`);
        verifyTrack(item, body, track);
        const parsed = await api("/parse", "POST", { command: body.command, track: item.track });
        check(parsed.engine === item.variant.engine, "Parsed engine differs from catalog");
        check(parsed.cards === item.variant.requires.gpus * body.machine_count, "Catalog GPU count differs from launch flags");
        check(!(parsed.warnings || []).length, "Launch parser reported warnings; review config before replay");
        // Persist normalized arguments, so placement fields in a command cannot override the track.
        delete body.command;
        body.engine_args = parsed.engine_args;
        const identity = hash({
          head,
          file: item.file,
          variant: item.variant,
          track: item.track,
          benchmark: track.benchmark_config_hash,
          body,
          attempt,
        });
        body.name = `catalog-ci-${pr}-${item.variant.id}-${identity.slice(0, 12)}`.slice(0, 128);
        body.notes = `${prefix}${identity}\n${runUrl}\n${item.file}#${item.variant.id}\ncommit ${head}\nsource run ${item.source_run_id}`;
        prepared.push({ item, body, track });
      }
      const wanted = new Set(prepared.map((p) => p.body.notes.split("\n")[0]));
      const existing = await api("/submissions");
      // Recover after runner loss, and cancel superseded work for this PR only.
      for (const sub of existing) {
        if (sub.notes?.startsWith(prefix) && !wanted.has(sub.notes.split("\n")[0]) && verdict(sub) === "pending") {
          await abort(sub.id);
        }
      }
      for (const { item, body, track } of prepared) {
        const report = { file: item.file, variant: item.variant.id, track: item.track, result: "pending" };
        currentReport = report;
        reports.push(report);
        await current();
        check(Date.now() < deadline, "Validation deadline exceeded before submission");
        const marker = body.notes.split("\n")[0];
        let sub = existing.find((s) => s.track_id === track.id && s.notes?.split("\n")[0] === marker);
        if (!sub) {
          // POST is deliberately not retried: the server has no atomic idempotency key.
          sub = await api(`/tracks/${encodeURIComponent(item.track)}/submissions`, "POST", body);
        }
        report.submission_id = sub.id;
        active.add(sub.id);
        while (true) {
          await current();
          check(Date.now() < deadline, "Validation deadline exceeded (including queue time)");
          sub = await pollSubmission(sub.id);
          report.result = verdict(sub);
          if (report.result === "failed") {
            report.failure_reason =
              sub.status === "measured" ? "Measurement did not pass the track gates." : `Submission ended with status: ${sub.status}`;
          }
          if (report.result !== "pending") break;
          // Short sleeps allow signal-driven cancellation to finish before runner termination.
          for (let i = 0; i < 15 && !stopping; i++) await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        active.delete(sub.id);
        report.run_id = sub.latest_measurement?.run_id ?? sub.run_id;
        // Public output excludes raw metrics, private URLs, model paths and logs.
        report.report_available = Boolean(sub.latest_measurement?.llmbench_url);
        const latestTrack = await api(`/tracks/${encodeURIComponent(item.track)}`);
        check(Date.now() < deadline, "Validation deadline exceeded (including queue time)");
        check(
          latestTrack.benchmark_config_hash === track.benchmark_config_hash,
          "Track benchmark changed during validation; rerun against its current rules",
        );
        if (report.result === "passed") {
          const row = latestTrack.board?.find((r) => r.submission_id === sub.id && r.measurement_id === sub.latest_measurement.id);
          // The board also applies confirmed quality floors and scenario gates.
          if (!row || row.stale_benchmark || row.unranked_reason) {
            report.result = "failed";
            report.failure_reason = !row
              ? "Completed measurement is missing from the current track board."
              : row.stale_benchmark
                ? "Measurement used a stale track benchmark."
                : `Track board marked the measurement ineligible: ${row.unranked_reason}`;
          }
        }
        currentReport = undefined;
      }
    }
    check(
      reports.every((r) => r.result === "passed"),
      "One or more variants failed the track's existing gates",
    );
    await current();
    await status("success", reports.length ? `${reports.length} new variants passed` : "No new variants to validate");
  } catch (error) {
    if (currentReport) {
      currentReport.result = error.message.includes("deadline exceeded") ? "timed_out" : "failed";
      currentReport.failure_reason = error.message;
    }
    await status("failure", "Track validation failed; see workflow summary").catch(() => {});
    throw error;
  } finally {
    for (const id of active) {
      await abort(id).catch(() => console.error(`Could not abort submission ${id}; operator cleanup required`));
    }
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    fs.mkdirSync("artifacts/autotune-validation", { recursive: true });
    fs.writeFileSync("artifacts/autotune-validation/results.json", JSON.stringify({ head, reports }, null, 2));
    if (env.GITHUB_STEP_SUMMARY) {
      const text =
        "## Original-track validation\n\nEngine replay using existing track rules; Swiss/chart runtime is not exercised.\n\n" +
        reports
          .map((r) => `- ${r.variant.replace(/[^\w-]/g, "_")}: ${r.result}; submission ${r.submission_id}, run ${r.run_id || "pending"}`)
          .join("\n") +
        "\n";
      fs.appendFileSync(env.GITHUB_STEP_SUMMARY, text);
    }
  }
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { main };
