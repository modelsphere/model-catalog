"use strict";
// Whether a perf report is a page someone can read. The site links only those,
// and validate:schema fails on any other, so the two cannot disagree.

const fs = require("fs");
const { HtmlValidate, StaticConfigLoader } = require("html-validate");

// Conformance to the HTML standard for a whole document, without style rules:
// a cut-off file fails as an unclosed element, a non-HTML one on its doctype.
const validator = new HtmlValidate(
  new StaticConfigLoader({ extends: ["html-validate:standard", "html-validate:document"] })
);

// A report renders from the JSON it embeds, so a page that is valid HTML but
// carries broken JSON still shows nothing.
const JSON_BLOCK = /<script\b[^>]*\btype\s*=\s*["']?application\/(?:ld\+)?json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi;

// Why the report at file cannot be linked, or null when it can.
function reportProblem(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    return err.code === "ENOENT" ? "no such file" : err.message;
  }
  if (text.trim() === "") return "empty file";

  const messages = validator.validateStringSync(text, file).results.flatMap((r) => r.messages);
  if (messages.length > 0) {
    const shown = messages.slice(0, 3).map((m) => `${m.line}:${m.column} ${m.message} (${m.ruleId})`);
    if (messages.length > 3) shown.push(`and ${messages.length - 3} more`);
    return `not valid HTML: ${shown.join("; ")}`;
  }

  for (const block of text.matchAll(JSON_BLOCK)) {
    try {
      JSON.parse(block[1]);
    } catch (err) {
      const line = text.slice(0, block.index).split("\n").length;
      return `${line}: the JSON in <script type="application/json"> does not parse: ${err.message}`;
    }
  }
  return null;
}

module.exports = { reportProblem };
