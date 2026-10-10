"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { reportProblem, jsonBlocks } = require("./report");

function file(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "report-"));
  const p = path.join(dir, "r.html");
  if (content != null) fs.writeFileSync(p, content);
  return p;
}

const page = (data) =>
  `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>r</title></head>\n<body>\n` +
  `<div id="report"></div>\n<script type="application/json" id="report-data">${data}</script>\n</body>\n</html>\n`;

test("a valid document with valid embedded JSON is linkable", () => {
  assert.equal(reportProblem(file(page('{"rows": [1, 2]}'))), null);
});

test("a missing or empty report is not", () => {
  assert.equal(reportProblem(file(null)), "no such file");
  assert.equal(reportProblem(file("")), "empty file");
  assert.equal(reportProblem(file(" \n")), "empty file");
});

test("a report that is not an HTML document is not", () => {
  assert.match(reportProblem(file("# a markdown report\n")), /^not valid HTML: .*missing-doctype/);
});

test("a report cut off mid-file is not", () => {
  const whole = page('{"rows": [1, 2]}');
  assert.match(reportProblem(file(whole.slice(0, whole.indexOf("[1")))), /^not valid HTML: .*expected <\/script>/);
});

test("valid HTML carrying broken JSON is not", () => {
  assert.match(reportProblem(file(page('{"rows": [1, 2'))), /^6: the JSON .* does not parse/);
});

test("JSON blocks are the script elements a browser would read as data", () => {
  const html =
    `<!doctype html><html><head><title>r</title></head><body>\n` +
    `<!-- <script type="application/json">{"commented": 1}</script> -->\n` +
    `<div title='<script type="application/json">{"attribute": 1}</script>'></div>\n` +
    `<script type=application/json id=a>{"a": 1}</script>\n` +
    `<script TYPE="Application/JSON">{"b": 2}</script>\n` +
    `<script type="application/ld+json">{"c": 3}</script>\n` +
    `<script>var d = 4;</script>\n</body></html>\n`;
  assert.deepEqual(jsonBlocks(html), [
    { id: "a", text: '{"a": 1}', line: 4 },
    { id: undefined, text: '{"b": 2}', line: 5 },
    { id: undefined, text: '{"c": 3}', line: 6 },
  ]);
});
