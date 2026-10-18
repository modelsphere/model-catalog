"use strict";
// Who may write: static bearer tokens, from a YAML file mounted beside the
// server, each naming who it is -- the author of the commits it makes:
//
//   - name: Ada Lovelace
//     email: ada@example.com
//     sha256: 9f86d081884c7d65...   # of the token: printf %s "$TOKEN" | sha256sum
//   - name: CI
//     email: ci@example.com
//     token: s3cret                 # or the token itself
//
// The file is read again when it changes, so a token is added or revoked
// without a restart.

const crypto = require("crypto");
const fs = require("fs");
const yaml = require("yaml");

const sha256 = (s) => crypto.createHash("sha256").update(s).digest();

function parseTokens(text, file = "tokens") {
  const doc = yaml.parse(text) ?? [];
  if (!Array.isArray(doc)) throw new Error(`${file}: want a list of {name, email, token or sha256}`);
  return doc.map((t, i) => {
    const at = `${file}[${i}]`;
    if (typeof t?.name !== "string" || !t.name.trim()) throw new Error(`${at}: name is missing`);
    if (typeof t.email !== "string" || !/^[^\s<>@]+@[^\s<>]+$/.test(t.email)) throw new Error(`${at}: email is missing or not one`);
    let hash;
    if (typeof t.sha256 === "string" && /^[0-9a-f]{64}$/i.test(t.sha256)) hash = Buffer.from(t.sha256, "hex");
    else if (typeof t.token === "string" && t.token.length >= 16) hash = sha256(t.token);
    else throw new Error(`${at}: want sha256 (64 hex digits) or token (16 characters or more)`);
    return { name: t.name.trim(), email: t.email, hash };
  });
}

class Tokens {
  constructor(file) {
    this.file = file;
    this.mtime = null;
    this.list = [];
  }

  load() {
    const { mtimeMs } = fs.statSync(this.file);
    if (mtimeMs !== this.mtime) {
      this.list = parseTokens(fs.readFileSync(this.file, "utf8"), this.file);
      this.mtime = mtimeMs;
    }
    return this.list;
  }

  // Who the Authorization header names, or null. Every entry is compared, in
  // constant time, so a timing says nothing of which came close.
  who(header) {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
    if (!m) return null;
    const hash = sha256(m[1]);
    let found = null;
    for (const t of this.load()) if (crypto.timingSafeEqual(t.hash, hash) && !found) found = t;
    return found && { name: found.name, email: found.email };
  }
}

module.exports = { Tokens, parseTokens };
