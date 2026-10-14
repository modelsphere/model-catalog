"use strict";
// The validators' terminal style: bold headings, a mark per check and a summary
// line green or red. Color only a terminal; piped output and CI logs stay plain.

const { styleText } = require("node:util");

const paint = (format, text) => styleText(format, text, { stream: process.stdout });
const marks = { pass: paint("green", "✓"), fail: paint("red", "✗"), warn: paint("yellow", "!"), skip: paint("dim", "-") };
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

module.exports = { paint, marks, plural };
