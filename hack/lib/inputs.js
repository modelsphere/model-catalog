"use strict";
// A variant's inputs, past what the schema can see. A path is declared once, and
// values leaves it alone: swiss puts the answer, the site's or else the input's
// default, in the derived layer. The example and the default are valid answers.
// swiss repeats these checks when it loads a variant (internal/catalog).

// Problems with one variant's inputs, each line prefixed with at.
function inputProblems(variant, at = "") {
  const inputs = Array.isArray(variant?.inputs) ? variant.inputs : [];
  const lines = [];
  const declared = new Set();
  for (const [i, input] of inputs.entries()) {
    if (typeof input?.path !== "string") continue; // the schema reports it
    const where = `${at}inputs[${i}] ${input.path}: `;
    if (declared.has(input.path)) lines.push(`${where}declared twice`);
    declared.add(input.path);
    const set = valueSetAt(variant.values, input.path.split("."));
    if (set) lines.push(`${where}values.${set} sets it; give the value as the input's default`);
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
    const answerProblem = (v) => {
      const ok = type === "integer" ? Number.isInteger(v) : typeof v === type;
      if (!ok) return `${JSON.stringify(v)} is not ${type === "integer" ? "an" : "a"} ${type}`;
      if (pattern && !pattern.test(v)) return `${JSON.stringify(v)} does not match the pattern`;
      return "";
    };
    for (const field of ["example", "default"]) {
      if (!(field in input)) continue;
      const problem = answerProblem(input[field]);
      if (problem) lines.push(`${where}${field} ${problem}`);
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
    if (!Object.hasOwn(node, key)) return "";
    node = node[key];
  }
  return keys.join(".");
}

module.exports = { inputProblems };
