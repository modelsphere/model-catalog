import { afterEach, describe, expect, test, vi } from "vitest";
import { forgetInit, loadCapabilities, loadInit, setToken, topLevel, withTopLevel, write, WriteError } from "./edit";

afterEach(() => vi.unstubAllGlobals());

const answer = (status: number, body: unknown, type = "application/json") =>
  vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": type } }));

describe("capabilities", () => {
  test("a server that takes writes says so", async () => {
    vi.stubGlobal("fetch", answer(200, { apiVersion: "catalog.swiss/v2", write: true, auth: "bearer" }));
    expect(await loadCapabilities("https://a.example/")).toEqual({ write: true });
  });

  test("a static host is read-only: a 404, a page, no network", async () => {
    vi.stubGlobal("fetch", answer(404, "not found", "text/plain"));
    expect(await loadCapabilities("https://b.example/")).toEqual({ write: false });
    vi.stubGlobal("fetch", answer(200, "<!doctype html>", "text/html"));
    expect(await loadCapabilities("https://c.example/")).toEqual({ write: false });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    expect(await loadCapabilities("https://d.example/")).toEqual({ write: false });
    vi.stubGlobal("fetch", answer(200, { write: false, auth: "bearer" }));
    expect(await loadCapabilities("https://e.example/")).toEqual({ write: false });
  });
});

describe("set up", () => {
  test("an empty catalog says so, and is asked again once forgotten", async () => {
    vi.stubGlobal("fetch", answer(200, { initialized: false, commit: null }));
    expect(await loadInit("https://i.example/")).toEqual({ initialized: false, commit: null });
    vi.stubGlobal("fetch", answer(200, { initialized: true, commit: "c0ffee" }));
    expect(await loadInit("https://i.example/")).toEqual({ initialized: false, commit: null });
    forgetInit("https://i.example/");
    expect(await loadInit("https://i.example/")).toEqual({ initialized: true, commit: "c0ffee" });
  });

  test("a server that cannot say has nothing to set up", async () => {
    vi.stubGlobal("fetch", answer(404, "not found", "text/plain"));
    expect((await loadInit("https://j.example/")).initialized).toBe(true);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    expect((await loadInit("https://k.example/")).initialized).toBe(true);
  });
});

describe("write", () => {
  test("names what it replaces, and carries the message in the query", async () => {
    const fetch = answer(200, { commit: "c0ffee", path: "models/m/a.yaml" });
    vi.stubGlobal("fetch", fetch);
    setToken("https://w.example/", "t0ken");
    await write("https://w.example/", {
      method: "PUT",
      api: "api/v2/models/m/variants/a",
      body: "x",
      etag: '"sha256:1"',
      message: "a: 显存",
      dryRun: true,
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://w.example/api/v2/models/m/variants/a?dryRun=true&message=${encodeURIComponent("a: 显存").replace(/%20/g, "+")}`);
    expect(init.headers).toEqual({ Authorization: "Bearer t0ken", "If-Match": '"sha256:1"', "Content-Type": "application/yaml" });
  });

  test("a refusal says why, and whether someone else got there first", async () => {
    setToken("https://w.example/", "t0ken");
    vi.stubGlobal("fetch", answer(422, { error: "no", problems: ["version: raise it"] }));
    const refused = await write("https://w.example/", { method: "PUT", api: "x" }).catch((e) => e);
    expect(refused).toBeInstanceOf(WriteError);
    expect([refused.status, refused.problems, refused.conflict]).toEqual([422, ["version: raise it"], false]);
    vi.stubGlobal("fetch", answer(412, { error: "changed", current: "sha256:2" }));
    expect((await write("https://w.example/", { method: "PUT", api: "x" }).catch((e) => e)).conflict).toBe(true);
    setToken("https://w.example/", null);
    expect((await write("https://w.example/", { method: "PUT", api: "x" }).catch((e) => e)).status).toBe(401);
  });
});

test("a top-level scalar is read and set without a YAML parser", () => {
  const text = 'apiVersion: catalog.swiss/v2\nid: "tp4" # quoted\nvalues:\n  id: nested\nversion: 1.0.2\n';
  expect(topLevel(text, "id")).toBe("tp4");
  expect(topLevel(text, "version")).toBe("1.0.2");
  expect(topLevel(text, "model")).toBe(null);
  expect(withTopLevel(text, "version", "1.0.0")).toContain("\nversion: 1.0.0\n");
  const copy = withTopLevel(text, "id", "tp4-copy");
  expect([topLevel(copy, "id"), copy.includes("  id: nested\n")]).toEqual(["tp4-copy", true]);
  expect(withTopLevel("a: 1\n", "id", "x")).toBe("id: x\na: 1\n");
});
