"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { reportProblem } = require("./report");

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
