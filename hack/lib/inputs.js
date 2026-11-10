"use strict";
// requires.inputs, past what the schema can see. A path is declared once; a
// value values gives it is its default, and like the example it must be a valid
// answer. swiss repeats these checks when it loads a variant (internal/catalog).

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
    if ("example" in input) {
      const problem = answerProblem(input.example);
      if (problem) lines.push(`${where}example ${problem}`);
    }
    const found = valueAt(variant.values, input.path.split("."));
    if (found.blocked) {
      lines.push(`${where}values.${found.blocked} is not a map, so it cannot hold this input`);
    } else if ("value" in found) {
      const problem = answerProblem(found.value);
      if (problem) lines.push(`${where}default ${problem}`);
    }
  }
  return lines;
}

// What values holds at a path: { value }, or { blocked } naming a non-map on the way.
function valueAt(values, keys) {
  let node = values;
  for (const [i, key] of keys.entries()) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return i > 0 ? { blocked: keys.slice(0, i).join(".") } : {};
    if (!Object.hasOwn(node, key)) return {};
    node = node[key];
  }
  return { value: node };
}

module.exports = { inputProblems, valueAt };
