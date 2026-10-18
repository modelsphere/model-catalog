// Editing the catalog, where its server takes writes (lib/edit.ts): a
// variant's file and a model's metadata.yaml edited in place, a new variant
// or model, a variant deleted. Each is a dialog over the page that checks the
// change with the server (a dry run) before committing it, and the page shows
// the catalog as the commit left it. None of it shows on a read-only catalog,
// or in an element marked readonly.
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useNavigate, useRevalidator } from "react-router";
import type { Model, Variant } from "@/types";
import { anchorOf } from "@/lib/catalog";
import { forgetCatalog } from "@/lib/data";
import {
  forgetInit,
  initApi,
  loadCapabilities,
  loadInit,
  metadataApi,
  modelsApi,
  onTokens,
  readFile,
  setToken,
  tokenFor,
  topLevel,
  variantApi,
  withTopLevel,
  write,
  WriteError,
  type Written,
} from "@/lib/edit";
import { useHost } from "@/lib/host";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { icons } from "./icons";

// What this page may do with its catalog: write, where the server takes
// writes and the host has not said readonly; and whether the catalog is set
// up (null until known, or where nothing is written). Asked again after the
// catalog is set up (setUp).
type WriteState = { write: boolean; initialized: boolean | null };

let generation = 0;
const generationListeners = new Set<() => void>();
const onGeneration = (f: () => void) => {
  generationListeners.add(f);
  return () => {
    generationListeners.delete(f);
  };
};
function setUp(base: string) {
  forgetInit(base);
  generation++;
  for (const f of generationListeners) f();
}

function useWriteState(): WriteState {
  const { base, readonly } = useHost();
  const gen = useSyncExternalStore(onGeneration, () => generation);
  const [state, setState] = useState<WriteState>({ write: false, initialized: null });
  useEffect(() => {
    if (readonly) return;
    let live = true;
    loadCapabilities(base).then(async (c) => {
      const initialized = c.write ? (await loadInit(base)).initialized : null;
      if (live) setState({ write: c.write, initialized });
    });
    return () => {
      live = false;
    };
  }, [base, readonly, gen]);
  return readonly ? { write: false, initialized: null } : state;
}

// Whether this page edits its catalog: one set up, on a server that takes
// writes. False until the server has said.
export function useEditable(): boolean {
  const { write, initialized } = useWriteState();
  return write && initialized === true;
}

// Whether this page offers to set the catalog up: an empty one, on a server
// that takes writes.
export function useSetupable(): boolean {
  const { write, initialized } = useWriteState();
  return write && initialized === false;
}

function useToken(base: string) {
  return useSyncExternalStore(onTokens, () => tokenFor(base));
}

// After a commit: the catalog is fetched again, and every route shows it.
function useReload() {
  const { base } = useHost();
  const { revalidate } = useRevalidator();
  return async () => {
    forgetCatalog(base);
    await revalidate();
  };
}

// The token a write is made with, asked for once: kept for the tab, or for
// the browser when remembered. A token the server refused is asked for again.
function TokenForm({ refused }: { refused: boolean }) {
  const { base } = useHost();
  const token = useToken(base);
  const [value, setValue] = useState("");
  const [remember, setRemember] = useState(false);
  if (token && !refused) {
    return (
      <p className="text-[0.8rem] text-faint">
        Writing with a token kept {localStorageHas(base) ? "in this browser" : "for this tab"}.{" "}
        <Button variant="link" size="none" type="button" onClick={() => setToken(base, null)}>
          Forget it
        </Button>
      </p>
    );
  }
  return (
    <form
      className="grid gap-2 rounded-lg border border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) setToken(base, value.trim(), remember);
        setValue("");
      }}
    >
      <label className="text-[0.84rem]" htmlFor="catalog-token">
        {refused ? "The server did not take that token. " : ""}A token for this catalog, from whoever runs its server:
      </label>
      <div className="flex gap-2">
        <Input id="catalog-token" type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />
        <Button type="submit" disabled={!value.trim()}>
          Use it
        </Button>
      </div>
      <label className="flex items-center gap-2 text-[0.8rem] text-muted-foreground">
        <input type="checkbox" className="accent-primary" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        Remember it in this browser
      </label>
    </form>
  );
}

function localStorageHas(base: string) {
  try {
    return localStorage.getItem(`catalog-token:${base}`) != null;
  } catch {
    return false;
  }
}

// What the server said of the last check or commit.
type Outcome = { kind: "checked"; w: Written } | { kind: "failed"; err: WriteError } | null;

function OutcomeNote({ outcome, onReload }: { outcome: Outcome; onReload?: () => void }) {
  if (!outcome) return null;
  if (outcome.kind === "checked") {
    const w = outcome.w;
    return (
      <p className="rounded-md border border-border bg-muted px-3 py-2 text-[0.84rem]">
        {w.unchanged
          ? "Nothing to commit: this is the file as it is."
          : `The server takes it${w.version ? `: ${w.id} ${w.version}` : ""}. Nothing is committed until you commit it.`}
      </p>
    );
  }
  const { err } = outcome;
  return (
    <div role="alert" className="rounded-md border border-destructive/50 px-3 py-2 text-[0.84rem] text-destructive">
      <p>{err.conflict ? "Someone changed this since you opened it. Reload it to see their change; your edits here are lost." : err.message}</p>
      {err.problems.length > 0 && (
        <ul className="mt-1 list-disc pl-5 wrap-anywhere">
          {err.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {err.conflict && onReload && (
        <Button type="button" size="sm" className="mt-2" onClick={onReload}>
          Reload it
        </Button>
      )}
    </div>
  );
}

const textarea =
  "block h-[min(24rem,45dvh)] w-full resize-y rounded-md border border-input bg-card px-3 py-2 font-mono text-[0.8rem] leading-[1.5] whitespace-pre text-foreground focus-visible:border-primary focus-visible:outline-offset-0";

// A file the dialog edits: read from the server (with the digest a write
// sends back), or a new one, from a template.
type File = { label: string; read?: () => Promise<{ text: string; etag: string }>; template?: string };

// A dialog that edits files and commits them: check runs commit as a dry run.
function EditorDialog({
  trigger,
  title,
  description,
  files,
  commit,
  done,
}: {
  trigger: ReactNode;
  title: ReactNode;
  description: ReactNode;
  files: File[];
  commit: (texts: string[], etags: string[], o: { dryRun: boolean; message: string }) => Promise<Written>;
  done?: (w: Written) => void;
}) {
  const { base } = useHost();
  const token = useToken(base);
  const reload = useReload();
  const [open, setOpen] = useState(false);
  const [texts, setTexts] = useState<string[] | null>(null);
  const [etags, setEtags] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"check" | "commit" | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = () => {
    setTexts(null);
    setOutcome(null);
    setLoadError(null);
    Promise.all(files.map((f) => (f.read ? f.read() : Promise.resolve({ text: f.template ?? "", etag: "" })))).then(
      (got) => {
        setTexts(got.map((g) => g.text));
        setEtags(got.map((g) => g.etag));
      },
      (err: Error) => setLoadError(err.message),
    );
  };
  // Each time it opens, the files are read as they are then.
  useEffect(() => {
    if (open) {
      setMessage("");
      load();
    }
  }, [open]);

  const run = async (dryRun: boolean) => {
    if (!texts) return;
    setBusy(dryRun ? "check" : "commit");
    setOutcome(null);
    try {
      const w = await commit(texts, etags, { dryRun, message });
      if (dryRun) setOutcome({ kind: "checked", w });
      else {
        await reload();
        setOpen(false);
        done?.(w);
      }
    } catch (err) {
      setOutcome({ kind: "failed", err: err instanceof WriteError ? err : new WriteError(0, (err as Error).message) });
    } finally {
      setBusy(null);
    }
  };
  const refused = outcome?.kind === "failed" && outcome.err.status === 401;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="wrap-anywhere">{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto px-5 py-4">
          {/* Asked for first: nothing is checked or committed without it. */}
          {(!token || refused) && <TokenForm refused={refused} />}
          {loadError ? (
            <p className="text-[0.88rem] text-destructive">Could not read it: {loadError}</p>
          ) : !texts ? (
            <p className="text-[0.88rem] text-muted-foreground">Loading…</p>
          ) : (
            files.map((f, i) => (
              <label key={f.label} className="grid gap-1 text-[0.8rem] text-muted-foreground">
                <span className="font-mono">{f.label}</span>
                <textarea
                  className={cn(textarea, files.length > 1 && "h-[min(16rem,32dvh)]")}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  value={texts[i]}
                  onChange={(e) => {
                    setTexts(texts.map((t, j) => (j === i ? e.target.value : t)));
                    setOutcome(null);
                  }}
                />
              </label>
            ))
          )}
          <OutcomeNote outcome={outcome} onReload={load} />
          {token && !refused && <TokenForm refused={false} />}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3">
          <Input
            aria-label="Commit message"
            placeholder="Commit message (optional)"
            className="min-h-0 flex-[1_1_16rem] py-[0.35rem] text-[0.84rem]"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <Button type="button" disabled={!texts || !token || busy != null} onClick={() => run(true)}>
            {busy === "check" ? "Checking…" : "Check"}
          </Button>
          <Button
            type="button"
            className="border-primary bg-primary text-primary-foreground hover:text-primary-foreground hover:opacity-90"
            disabled={!texts || !token || busy != null}
            onClick={() => run(false)}
          >
            {busy === "commit" ? "Committing…" : "Commit"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// A variant's file, edited in place: its version must go up with it.
export function EditVariant({ m, v }: { m: Model; v: Variant }) {
  const { base } = useHost();
  const api = variantApi(m.name, v.id);
  return (
    <EditorDialog
      trigger={<Button size="sm">{icons.edit}Edit</Button>}
      title={<span className="font-mono">{v.id}</span>}
      description={
        <>
          <code>{v.path}</code>, at version {v.version}. Raise <code>version</code> with your change: the one you replace stays in its history.
        </>
      }
      files={[{ label: v.path, read: () => readFile(base, api) }]}
      commit={([text], [etag], o) => write(base, { method: "PUT", api, body: text, etag, ...o })}
    />
  );
}

// A new variant of a model, starting from a copy of one it has.
export function NewVariant({ m, from }: { m: Model; from: { id: string; yaml: string } | null }) {
  const { base } = useHost();
  const navigate = useNavigate();
  const template = from
    ? withTopLevel(withTopLevel(from.yaml, "id", `${from.id}-copy`), "version", "1.0.0")
    : `apiVersion: catalog.swiss/v2\nkind: Variant\nmodel: ${m.name}\nid: new-variant\nversion: 1.0.0\nengine: vllm\nchart:\n  name: vllm\n  version: ">=0.1.0"\nrequires:\n  gpus: 1\n`;
  return (
    <EditorDialog
      trigger={<Button>{icons.add}New recipe</Button>}
      title={`A new recipe for ${m.displayName}`}
      description={
        <>
          {from ? (
            <>
              A copy of <code>{from.id}</code> to start from.
            </>
          ) : null}{" "}
          Its <code>id</code> names its file, <code>models/{m.name}/&lt;id&gt;.yaml</code>.
        </>
      }
      files={[{ label: `models/${m.name}/<id>.yaml`, template }]}
      commit={([text], _, o) => {
        const id = topLevel(text, "id");
        if (!id) return Promise.reject(new WriteError(422, "Give it an id: it names the file."));
        return write(base, { method: "PUT", api: variantApi(m.name, id), body: text, create: true, ...o });
      }}
      done={(w) => w.id && navigate({ hash: anchorOf(w.id) })}
    />
  );
}

// A model's metadata.yaml, edited in place.
export function EditMetadata({ m }: { m: Model }) {
  const { base } = useHost();
  const api = metadataApi(m.name);
  return (
    <EditorDialog
      trigger={<Button>{icons.edit}Edit model</Button>}
      title={m.displayName}
      description={
        <>
          <code>models/{m.name}/metadata.yaml</code>: what the catalog says of the model, its default recipe and its tuning.
        </>
      }
      files={[{ label: `models/${m.name}/metadata.yaml`, read: () => readFile(base, api) }]}
      commit={([text], [etag], o) => write(base, { method: "PUT", api, body: text, etag, ...o })}
    />
  );
}

const NEW_METADATA = `apiVersion: catalog.swiss/v2
name: my-model
displayName: My Model
description: What it is, in a sentence.
source:
  hf: org/my-model
defaultVariant: vllm-tp1
`;

const NEW_VARIANT = `apiVersion: catalog.swiss/v2
kind: Variant
model: my-model
id: vllm-tp1
version: 1.0.0
engine: vllm
description: One GPU.
chart:
  name: vllm
  version: ">=0.1.0"
requires:
  gpus: 1
`;

// A new model, with its first recipe: one commit.
export function NewModel() {
  const { base } = useHost();
  const navigate = useNavigate();
  return (
    <EditorDialog
      trigger={<Button>{icons.add}New model</Button>}
      title="A new model"
      description={
        <>
          Its <code>metadata.yaml</code> and a first recipe. The <code>name</code> names its directory, <code>models/&lt;name&gt;/</code>, and the
          recipe's <code>model</code> is that name.
        </>
      }
      files={[
        { label: "models/<name>/metadata.yaml", template: NEW_METADATA },
        { label: "models/<name>/<id>.yaml", template: NEW_VARIANT },
      ]}
      commit={([metadata, variant], _, o) =>
        write(base, { method: "POST", api: modelsApi, body: JSON.stringify({ metadata, variants: [variant] }), ...o })
      }
      done={(w) => w.model && navigate(`/models/${w.model}`)}
    />
  );
}

// A variant deleted, once confirmed. Its history stays, and so does every
// revision of it a deploy may be pinned to.
export function DeleteVariant({ m, v }: { m: Model; v: Variant }) {
  const { base } = useHost();
  const token = useToken(base);
  const reload = useReload();
  const api = variantApi(m.name, v.id);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  useEffect(() => {
    if (open) {
      setOutcome(null);
      setMessage("");
    }
  }, [open]);
  const remove = async () => {
    setBusy(true);
    setOutcome(null);
    try {
      // At the digest the page shows: a change it has not seen is a conflict.
      await write(base, { method: "DELETE", api, etag: `"${v.digest}"`, message });
      await reload();
      setOpen(false);
    } catch (err) {
      setOutcome({ kind: "failed", err: err instanceof WriteError ? err : new WriteError(0, (err as Error).message) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" title={`Delete ${v.id}`}>
          {icons.remove}
          <span className="sr-only">Delete</span>
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Delete <span className="font-mono">{v.id}</span>?
          </DialogTitle>
          <DialogDescription>
            It leaves the catalog. Its history stays, and a deploy pinned to one of its versions still finds it. To steer people off it instead, edit
            it and set <code>deprecated</code>.
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto px-5 py-4">
          <OutcomeNote outcome={outcome} onReload={() => reload().then(() => setOpen(false))} />
          <TokenForm refused={outcome?.kind === "failed" && outcome.err.status === 401} />
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3">
          <Input
            aria-label="Commit message"
            placeholder="Commit message (optional)"
            className="min-h-0 flex-[1_1_16rem] py-[0.35rem] text-[0.84rem]"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <Button
            type="button"
            className="border-destructive text-destructive hover:border-destructive hover:text-destructive"
            disabled={!token || busy}
            onClick={remove}
          >
            {busy ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Setting up an empty catalog: its catalog.yaml (and the rest of the
// server's template) committed, so it takes models from then on.
export function SetupCatalog() {
  const { base } = useHost();
  const token = useToken(base);
  const reload = useReload();
  const [open, setOpen] = useState(false);
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  useEffect(() => {
    if (open) setOutcome(null);
  }, [open]);
  const run = async () => {
    setBusy(true);
    setOutcome(null);
    try {
      await write(base, { method: "POST", api: initApi, body: JSON.stringify(repo.trim() ? { repo: repo.trim() } : {}) });
      await reload();
      setUp(base);
      setOpen(false);
    } catch (err) {
      const e = err instanceof WriteError ? err : new WriteError(0, (err as Error).message);
      // Someone else set it up first: it is, all the same.
      if (e.status === 409) {
        await reload();
        setUp(base);
        setOpen(false);
      } else setOutcome({ kind: "failed", err: e });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="border-primary bg-primary text-primary-foreground hover:text-primary-foreground hover:opacity-90">
          {icons.add}Set up this catalog
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set up this catalog</DialogTitle>
          <DialogDescription>
            Its repository is empty. Setting it up commits a <code>catalog.yaml</code> and a <code>README.md</code> to it, as you; then it takes
            models.
          </DialogDescription>
        </DialogHeader>
        {/* Not a form: the token's is one of its own. */}
        <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto px-5 py-4">
          {!token && <TokenForm refused={false} />}
          <label className="grid gap-1 text-[0.84rem]">
            The repository&apos;s web address, for links to its commits (optional)
            <Input type="url" placeholder="https://git.example.com/ml/catalog" value={repo} onChange={(e) => setRepo(e.target.value)} />
          </label>
          <OutcomeNote outcome={outcome} />
          {token && <TokenForm refused={outcome?.kind === "failed" && outcome.err.status === 401} />}
        </div>
        <div className="flex justify-end border-t border-border px-5 py-3">
          <Button
            type="button"
            onClick={run}
            className="border-primary bg-primary text-primary-foreground hover:text-primary-foreground hover:opacity-90"
            disabled={!token || busy}
          >
            {busy ? "Setting up…" : "Set up"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
