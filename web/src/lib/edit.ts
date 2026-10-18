// Editing a catalog, where its server takes writes. catalog-server says so at
// api/v2/; a static host -- GitHub Pages, npm run serve -- has nothing there,
// and its catalog is read-only. A write goes to the server's API with a
// bearer token, which is kept in this browser (components/edit.tsx asks for
// it).

export type Capabilities = { write: boolean };

const capabilities = new Map<string, Promise<Capabilities>>();

// What the server at base takes, asked once per visit. Anything but its
// answer -- a 404, a page, no network -- is a read-only catalog.
export function loadCapabilities(base: string): Promise<Capabilities> {
  let c = capabilities.get(base);
  if (!c) {
    c = fetch(`${base}api/v2/`, { headers: { Accept: "application/json" } })
      .then(async (res) => {
        if (!res.ok || !res.headers.get("content-type")?.includes("json")) return { write: false };
        const body = await res.json();
        return { write: body?.write === true && body?.auth === "bearer" };
      })
      .catch(() => ({ write: false }));
    capabilities.set(base, c);
  }
  return c;
}

// Whether the catalog is set up: a catalog-server may start from an empty
// repository, which takes no writes until POST api/v2/init commits its
// catalog.yaml. Asked once per visit, and again after setting it up.
export type InitState = { initialized: boolean; commit: string | null };

const inits = new Map<string, Promise<InitState>>();

// Anything but the server's answer is a catalog set up already: one that
// cannot say has nothing to offer setting it up.
export function loadInit(base: string): Promise<InitState> {
  let i = inits.get(base);
  if (!i) {
    i = fetch(`${base}api/v2/init`, { headers: { Accept: "application/json" }, cache: "no-store" })
      .then(async (res) => {
        if (!res.ok || !res.headers.get("content-type")?.includes("json")) return { initialized: true, commit: null };
        const body = await res.json();
        return { initialized: body?.initialized !== false, commit: body?.commit ?? null };
      })
      .catch(() => ({ initialized: true, commit: null }));
    inits.set(base, i);
  }
  return i;
}

export function forgetInit(base: string) {
  inits.delete(base);
}

export const initApi = "api/v2/init";

// The token for the catalog at base: for this tab (sessionStorage), or, when
// remembered, this browser (localStorage). Kept in memory too, for a browser
// whose storage is off.
const tokens = new Map<string, string | null>();
const listeners = new Set<() => void>();
const key = (base: string) => `catalog-token:${base}`;

export function tokenFor(base: string): string | null {
  if (!tokens.has(base)) {
    let t: string | null = null;
    try {
      t = sessionStorage.getItem(key(base)) ?? localStorage.getItem(key(base));
    } catch {
      // No storage: a token lasts until the page goes.
    }
    tokens.set(base, t);
  }
  return tokens.get(base)!;
}

export function setToken(base: string, token: string | null, remember = false) {
  tokens.set(base, token);
  try {
    sessionStorage.removeItem(key(base));
    localStorage.removeItem(key(base));
    if (token) (remember ? localStorage : sessionStorage).setItem(key(base), token);
  } catch {
    // As above.
  }
  for (const f of listeners) f();
}

export function onTokens(f: () => void) {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
}

// The API's paths, under the catalog's root.
export const variantApi = (model: string, id: string) => `api/v2/models/${encodeURIComponent(model)}/variants/${encodeURIComponent(id)}`;
export const metadataApi = (model: string) => `api/v2/models/${encodeURIComponent(model)}/metadata`;
export const modelsApi = "api/v2/models";
// catalog.yaml: where the catalog is served (site, raw) and its repository.
export const settingsApi = "api/v2/catalog";

// What a write did, as the server says: its commit (null for a dry run) and
// the catalog's entry for what it wrote.
export type Written = {
  commit: string | null;
  path: string;
  model?: string;
  id?: string;
  version?: string;
  digest?: string;
  dryRun?: true;
  unchanged?: true;
  deleted?: true;
  // Setting the catalog up: the files it committed.
  initialized?: boolean;
  files?: string[];
};

// Why a write did not happen. status 412 and 409 are a file someone else
// changed since it was read; 422 lists the problems; 401 is the token.
export class WriteError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly problems: string[] = [],
  ) {
    super(message);
  }
  get conflict() {
    return this.status === 409 || this.status === 412;
  }
}

// A file as the API serves it, and the digest it was read at: what a write
// that replaces it sends back.
export async function readFile(base: string, api: string): Promise<{ text: string; etag: string }> {
  const res = await fetch(base + api, { cache: "no-store" });
  if (!res.ok) throw new WriteError(res.status, `${api}: ${res.status}`);
  return { text: await res.text(), etag: res.headers.get("etag") ?? "" };
}

export type WriteRequest = {
  method: "PUT" | "POST" | "DELETE";
  api: string;
  body?: string;
  // The digest the file was read at; or create, for a file that must not exist.
  etag?: string;
  create?: boolean;
  message?: string;
  dryRun?: boolean;
};

export async function write(base: string, r: WriteRequest): Promise<Written> {
  const token = tokenFor(base);
  if (!token) throw new WriteError(401, "Sign in with a token to write.");
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (r.etag) headers["If-Match"] = r.etag;
  if (r.create) headers["If-None-Match"] = "*";
  if (r.body != null) headers["Content-Type"] = r.method === "POST" ? "application/json" : "application/yaml";
  // In the query, not a header: a header cannot carry any text.
  const query = new URLSearchParams();
  if (r.dryRun) query.set("dryRun", "true");
  if (r.message?.trim()) query.set("message", r.message.trim());
  const url = base + r.api + (query.toString() ? `?${query}` : "");
  let res: Response;
  try {
    res = await fetch(url, { method: r.method, headers, body: r.body });
  } catch (err) {
    throw new WriteError(0, `Could not reach the catalog: ${(err as Error).message}`);
  }
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new WriteError(res.status, out.error ?? `${res.status} ${res.statusText}`, out.problems ?? []);
  return out as Written;
}

// A YAML document's top-level scalar, such as a new variant's id: what names
// the file it goes to, read without a YAML parser in the page.
export function topLevel(text: string, field: string): string | null {
  const m = new RegExp(`^${field}:[ \\t]*(?:"([^"]*)"|'([^']*)'|([^\\s#]+))`, "m").exec(text);
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
}

// text with a top-level scalar set, for a new file made from another.
export function withTopLevel(text: string, field: string, value: string): string {
  const line = new RegExp(`^${field}:.*$`, "m");
  return line.test(text) ? text.replace(line, `${field}: ${value}`) : `${field}: ${value}\n${text}`;
}
