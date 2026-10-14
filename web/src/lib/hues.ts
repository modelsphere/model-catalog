// Tag colors. The tags in use get a fixed hue; any other tag gets one picked
// from its name, so a new tag is colored and stays the same color. swiss's web
// (web/src/lib/catalog.ts) keeps the same table.
const TAG_HUES: Record<string, string> = {
  chat: "blue",
  reasoning: "purple",
  "tool-use": "green",
  moe: "orange",
  "speculative-decoding": "red",
  "long-context": "yellow",
  "multi-node": "grey",
  vision: "green",
  fp4: "orange",
  fallback: "grey",
};

// Sonokai's accents, the order an unlisted tag or GPU hashes into.
const HUES = ["blue", "purple", "green", "orange", "red", "yellow"];

// Each GPU keeps one color wherever it appears: toolbar filter, table tags,
// hardware lines. Fixed, so a filter never repaints the others; an unlisted
// GPU gets a stable hue from its name.
const GPU_HUES: Record<string, string> = {
  A100: "yellow",
  A800: "yellow",
  H20: "red",
  H100: "blue",
  H200: "yellow",
  H800: "green",
  B200: "red",
  B300: "purple",
  "RTX-6000D": "orange",
  "Ascend 910B3": "red",
  "any GPU": "grey",
};

// Vendors other than NVIDIA, as their GPU labels name them.
const OTHER_VENDORS = ["ascend", "cambricon", "hygon", "amd"];

// Topologies, as the topology filter shows them.
const TOPOLOGY_HUES: Record<string, string> = {
  "single-node": "blue",
  lws: "purple",
  pd: "orange",
};

export function tagHue(tag: string): string {
  if (TAG_HUES[tag]) return TAG_HUES[tag];
  let h = 0;
  for (const ch of tag) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length];
}

export function gpuHue(label: string): string {
  return GPU_HUES[label] || tagHue(label);
}

export function topologyHue(topology: string): string {
  return TOPOLOGY_HUES[topology] || tagHue(topology);
}

// NVIDIA's cards first, then other vendors', then "any GPU". Every other
// vendor's label carries its name, so the label alone says whose card it is.
export function gpuGroup(label: string): number {
  if (label === "any GPU") return 2;
  const l = label.toLowerCase();
  return OTHER_VENDORS.some((v) => l.includes(v)) ? 1 : 0;
}
