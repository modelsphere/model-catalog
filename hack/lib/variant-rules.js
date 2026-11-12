// The rules one variant is judged on beyond its schema: what the schema
// cannot express across fields. validate-schema runs them on every variant.
"use strict";

const { inputProblems } = require("./inputs");

// The LLM engines, each on the chart of its name. A mock runs on one of them;
// a video service brings a chart of its own.
const ENGINE_CHARTS = ["sglang", "vllm"];

function variantProblems(v, at) {
  const lines = [];
  const requires = v?.requires ?? {};
  const topology = requires.topology;
  // An LWS group that disagrees with requires.nodes hangs at rendezvous.
  const lws = v?.values?.lws;
  if (lws?.enabled === true && lws.size !== requires.nodes) {
    lines.push(`${at}values.lws.size ${lws.size} is not requires.nodes ${requires.nodes}`);
  }
  const chart = v?.chart?.name;
  if (chart && ENGINE_CHARTS.includes(v?.engine) && chart !== v.engine) {
    lines.push(`${at}chart.name ${chart} is not its engine, ${v.engine}`);
  }
  if (chart && v?.engine === "mock" && !ENGINE_CHARTS.includes(chart)) {
    lines.push(`${at}chart.name ${chart}: a mock runs on the sglang or vllm chart`);
  }
  if (v?.engine === "video") {
    if (chart && ENGINE_CHARTS.includes(chart)) {
      lines.push(`${at}chart.name ${chart}: a video variant runs on a video chart, not an engine chart`);
    }
    // requires is one pod of the chart, which lays out its own pods.
    if (topology && topology !== "single-node") {
      lines.push(`${at}requires.topology ${topology}: a video variant is single-node; its chart lays out its pods`);
    }
    if (requires.nodes !== undefined) {
      lines.push(`${at}requires.nodes ${requires.nodes}: a video variant takes no nodes; requires describes one pod`);
    }
    // lws and pd are layouts of an LLM engine chart; a video chart has neither.
    for (const key of ["lws", "pd"]) {
      if (v?.values?.[key] !== undefined) lines.push(`${at}values.${key}: a video chart has no ${key} layout`);
    }
  }
  // The chart renders what values enable, not what topology says.
  if (["lws", "pd"].includes(topology) && v?.values?.[topology]?.enabled !== true) {
    lines.push(`${at}requires.topology ${topology} needs values.${topology}.enabled: true`);
  }
  // CPU only: no accelerator, so nothing that picks or sizes one.
  if (requires.gpus === 0) {
    for (const key of ["vendor", "gpuProduct", "minGpuMemoryGiB", "rdma"]) {
      if (requires[key] !== undefined) lines.push(`${at}requires.${key} is set, but requires.gpus 0 is CPU only`);
    }
  }
  lines.push(...inputProblems(v, at));
  return lines;
}

module.exports = { ENGINE_CHARTS, variantProblems };
