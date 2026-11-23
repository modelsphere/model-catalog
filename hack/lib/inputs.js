"use strict";
// A variant's inputs, past what the schema can see. A key is declared once. A
// value values gives it is the base an answer overrides: swiss puts the answer,
// the site's or else the input's default, in the derived layer above it. The
// example and the default are valid answers. swiss repeats these checks when it
// loads a variant (internal/catalog).
//
// A key is a kyaml-style path (modelsphere/modelsphere#75): segments joined by
// ".", brackets kept whole. A field is a map key; [field=value] is the list item
// whose field equals value; [=value] the scalar list item equal to value;
// [^=prefix] the scalar list item starting with prefix; a bare number is an
// index on a list and the key "N" on a map. A key of fields only may be absent
// from values; any other key must reach exactly one string, number or boolean
// there, since the answer can only patch a list item that exists.

// Problems with one variant's inputs, each line prefixed with at.
function inputProblems(variant, at = "") {
  const inputs = Array.isArray(variant?.inputs) ? variant.inputs : [];
  const lines = [];
  const declared = new Set();
  for (const [i, input] of inputs.entries()) {
    if (typeof input?.key !== "string") continue; // the schema reports it
    const where = `${at}inputs[${i}] ${input.key}: `;
    if (declared.has(input.key)) lines.push(`${where}declared twice`);
    declared.add(input.key);
    const type = input.type ?? "string";
    const segs = splitKey(input.key);
    let current;
    if (segs.every(isField)) {
      const set = valueSetAt(variant.values, segs);
      if (set && set !== input.key) lines.push(`${where}values.${set} is not a map, so the answer has no place to go`);
      if (set === input.key) current = segs.reduce((node, seg) => node[seg], variant.values);
    } else {
      const found = findAt(variant.values, segs);
      if (found.length !== 1) lines.push(`${where}matches ${found.length} values in values, not exactly one`);
      else if (!isPrimitive(found[0].value)) lines.push(`${where}selects a non-primitive in values`);
      else current = found[0].value;
    }
    if (input.patcher !== undefined) {
      const parts = typeof input.patcher === "string" ? input.patcher.split("{value}") : [];
      if (parts.length !== 2) lines.push(`${where}patcher must contain {value} exactly once`);
      else if (type !== "string") lines.push(`${where}patcher is only for a string input, and this one is ${type}`);
      else if (current !== undefined && !fitsTemplate(current, parts)) {
        lines.push(`${where}values gives ${JSON.stringify(current)}, which does not fit the patcher`);
      }
    }
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

// The prefix of keys at which values already says something about a dotted
// key: the value itself, a value under it, or a non-map on the way to it.
// Empty when values leaves the key alone.
function valueSetAt(values, keys) {
  let node = values;
  for (const [i, key] of keys.entries()) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return i > 0 ? keys.slice(0, i).join(".") : "";
    if (!Object.hasOwn(node, key)) return "";
    node = node[key];
  }
  return keys.join(".");
}

// A key's segments: split on "." outside brackets.
function splitKey(key) {
  return key.match(/\[[^\]]*\]|[^.[]+/g) ?? [];
}

const isField = (seg) => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(seg);
const isPrimitive = (v) => ["string", "number", "boolean"].includes(typeof v);
const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const fitsTemplate = (v, [before, after]) =>
  typeof v === "string" && v.length >= before.length + after.length && v.startsWith(before) && v.endsWith(after);

// Every place in values a key reaches: { parent, at, value }, so a caller can
// read or replace parent[at].
function findAt(values, segs) {
  let here = [{ parent: null, at: null, value: values }];
  for (const seg of segs) {
    const next = [];
    for (const { value: node } of here) {
      const bracket = /^\[(\^?)([^=\]]*)=(.*)\]$/.exec(seg);
      if (bracket && Array.isArray(node)) {
        const [, prefix, field, want] = bracket;
        node.forEach((item, i) => {
          const v = field ? (isMap(item) ? item[field] : undefined) : item;
          const ok = prefix ? typeof v === "string" && v.startsWith(want) : isPrimitive(v) && String(v) === want;
          if (ok) next.push({ parent: node, at: i, value: item });
        });
      } else if (!bracket && /^(0|[1-9][0-9]*)$/.test(seg) && Array.isArray(node)) {
        if (Number(seg) < node.length) next.push({ parent: node, at: Number(seg), value: node[Number(seg)] });
      } else if (!bracket && isMap(node) && Object.hasOwn(node, seg)) {
        next.push({ parent: node, at: seg, value: node[seg] });
      }
    }
    here = next;
  }
  return here;
}

module.exports = { inputProblems, valueSetAt, splitKey, findAt };
