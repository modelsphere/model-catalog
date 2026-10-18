"use strict";
// The config file: defaults, paths from its own directory, and mistakes
// named rather than ignored.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { tmp } = require("./helpers");
const { loadConfig, configPath } = require("../src/config");

function withConfig(text, check) {
  const dir = tmp("config-");
  try {
    const file = path.join(dir, "catalog-server.yaml");
    fs.writeFileSync(file, text);
    return check(file, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("an empty config is every default, paths from its directory", () => {
  withConfig("", (file, dir) =>
    assert.deepEqual(loadConfig(file), {
      port: 8000,
      basePath: "/",
      repository: { dir: path.join(dir, "data/catalog"), branch: null, syncInterval: 30, template: null },
      committer: { name: "catalog-server", email: "catalog-server@localhost" },
      tokensFile: null,
      pagesDir: null,
    }),
  );
});

test("the example is a config, every setting in it known", () => {
  const example = path.join(__dirname, "../catalog-server.example.yaml");
  assert.equal(loadConfig(example).port, 8000);
  // With its commented-out settings in, too.
  const all = fs
    .readFileSync(example, "utf8")
    .replace(/^(\s*)# (\w+: .*)$/gm, "$1$2")
    .replace(/^(\s*)(pagesDir|template): .*$/gm, "");
  withConfig(all, (file) => {
    const cfg = loadConfig(file);
    assert.equal(cfg.repository.branch, "main");
  });
});

test("settings are read as given", () => {
  const text = [
    "port: 9000",
    "basePath: catalog",
    "repository: {dir: /srv/catalog, branch: main, syncInterval: 0}",
    "committer: {name: Catalog Bot, email: bot@example.com}",
    "tokensFile: secrets/tokens.yaml",
  ].join("\n");
  withConfig(text, (file, dir) => {
    const cfg = loadConfig(file);
    assert.deepEqual(
      [cfg.port, cfg.basePath, cfg.repository, cfg.committer.name, cfg.tokensFile],
      [
        9000,
        "/catalog/",
        { dir: "/srv/catalog", branch: "main", syncInterval: 0, template: null },
        "Catalog Bot",
        path.join(dir, "secrets/tokens.yaml"),
      ],
    );
  });
});

test("a mistake is named, every one of them", () => {
  const text = "prot: 8000\nport: http\nrepository: {dir: x, syncInterval: -1, upstream: y}\npublicUrl: catalog.example.com\npagesDir: nowhere\n";
  withConfig(text, (file) => {
    assert.throws(
      () => loadConfig(file),
      (err) =>
        [
          /prot: not a setting/,
          /port: want a number/,
          /repository\.upstream: not a setting/,
          /repository\.syncInterval: want seconds/,
          /publicUrl: not a setting .* -- where the catalog is served is its catalog\.yaml's site and raw/,
          /pagesDir: .*nowhere has no index\.html/,
        ].every((re) => re.test(err.message)),
    );
  });
  assert.throws(() => loadConfig("/nonexistent/catalog-server.yaml"), /no such file -- copy catalog-server\.example\.yaml/);
});

test("the config file is named on the command line", () => {
  assert.equal(configPath([]), "catalog-server.yaml");
  assert.equal(configPath(["--config", "/etc/c.yaml"]), "/etc/c.yaml");
  assert.equal(configPath(["--config=/etc/c.yaml", "--healthcheck"]), "/etc/c.yaml");
});
