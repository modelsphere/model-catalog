"use strict";
// requires.inputs, past what the schema can see. A path is declared once,
// values leaves it to the deploy -- an input with a default is not an input --
// and the example is a valid answer, since CI renders the chart with it. swiss
// repeats these checks when it loads a variant (internal/catalog).

// Problems with one variant's inputs, each line prefixed with at.
function inputProblems(variant, at = "") {
  const inputs = Array.isArray(variant?.requires?.inputs) ? variant.requires.inputs : [];
  const lines = [];
  const declared = new Set();
  for (const [i, input] of inputs.entries()) {
    if (typeof input?.path !== "string") continue; // the schema reports it
    const where = `${at}requires.inputs[${i}] ${input.path}: `;
    if (declared.has(input.path)) lines.push(`${where}declared twice`);
    declared.add(input.path);
    const set = valueSetAt(variant.values, input.path.split("."));
    if (set) lines.push(`${where}values.${set} sets it; values leaves an input unset, for the deploy to answer`);
    const type = input.type ?? "string";
    let pattern;
    if (input.pattern !== undefined && type !== "string") {
      lines.push(`${where}pattern is only for a string input, and this one is ${type}`);
    } else if (input.pattern !== undefined) {
      try {
        pattern = new RegExp(`^(?:${input.pattern})$`, "u");
      } catch (err) {
        lines.push(`${where}pattern does not compile: ${err.message}`);
      }
    }
    if ("example" in input) {
      const ok = type === "integer" ? Number.isInteger(input.example) : typeof input.example === type;
      if (!ok) lines.push(`${where}example ${JSON.stringify(input.example)} is not ${type === "integer" ? "an" : "a"} ${type}`);
      else if (pattern && !pattern.test(input.example)) lines.push(`${where}example ${JSON.stringify(input.example)} does not match the pattern`);
    }
  }
  return lines;
}

// The prefix of keys at which values already says something about a path:
// the value itself, a value under it, or a non-map on the way to it. Empty
// when values leaves the path alone.
function valueSetAt(values, keys) {
  let node = values;
  for (const [i, key] of keys.entries()) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return i > 0 ? keys.slice(0, i).join(".") : "";
    if (!(key in node)) return "";
    node = node[key];
  }
  return keys.join(".");
}

module.exports = { inputProblems };
