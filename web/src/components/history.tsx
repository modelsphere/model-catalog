// A variant's revision history, in a dialog over its model page: every
// version of its file, newest first, each with the commit that released it.
import { useEffect, useState } from "react";
import type { History, Model, Revision, Variant } from "@/types";
import { encodePath, measuredAs } from "@/lib/catalog";
import { loadHistory } from "@/lib/data";
import { useHost } from "@/lib/host";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { icons } from "./icons";
import { NEW_TAB } from "./catalog";

function RevisionItem({ m, v, r, current, repo, path }: { m: Model; v: Variant; r: Revision; current: boolean; repo: string | null; path: string }) {
  const measured = measuredAs(m, v.id, r.version);
  return (
    <li className="px-5 py-3 [&+&]:border-t [&+&]:border-border">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-[0.9rem] font-semibold tabular-nums">v{r.version}</span>
        {current && <Badge variant="quiet">current</Badge>}
        {measured && (
          <Badge variant="optimized" title={measured}>
            measured
          </Badge>
        )}
        <span className="ml-auto text-[0.8rem] text-faint tabular-nums">{r.releaseDate ?? "not committed"}</span>
      </div>
      <p className="mt-1 text-[0.86rem] wrap-anywhere text-muted-foreground">{r.subject}</p>
      {r.commit && repo && (
        <div className="mt-[0.35rem] flex flex-wrap gap-x-4 gap-y-1 text-[0.82rem]">
          <Button variant="link" size="none" asChild>
            <a href={`${repo}/commit/${r.commit}`} title={`Commit ${r.commit}`} {...NEW_TAB}>
              {icons.external}
              <code>{r.commit.slice(0, 7)}</code>
            </a>
          </Button>
          <Button variant="link" size="none" asChild>
            <a href={`${repo}/blob/${r.commit}/${encodePath(path)}`} {...NEW_TAB}>
              {icons.external}
              File at v{r.version}
            </a>
          </Button>
        </div>
      )}
    </li>
  );
}

export function VariantHistory({ m, v, repo }: { m: Model; v: Variant; repo: string | null }) {
  const { base } = useHost();
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<History | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || history) return;
    let live = true;
    setError(null);
    loadHistory(base, v).then(
      (h) => live && setHistory(h),
      (err: Error) => live && setError(err.message),
    );
    return () => {
      live = false;
    };
  }, [open, history, base, v]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">{icons.history}History</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-mono wrap-anywhere">{v.id}</DialogTitle>
          <DialogDescription>
            Every version of <code>{v.path}</code>, newest first. A deploy pins one by its commit.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {error ? (
            <p className="px-5 py-8 text-center text-[0.88rem] text-destructive">Could not load the history: {error}</p>
          ) : !history ? (
            <p className="px-5 py-8 text-center text-[0.88rem] text-muted-foreground">Loading…</p>
          ) : (
            <ol aria-label="Revisions">
              {history.revisions.map((r, i) => (
                <RevisionItem key={r.commit ?? r.digest} m={m} v={v} r={r} current={i === 0} repo={repo} path={history.path} />
              ))}
            </ol>
          )}
        </div>
        <div className="border-t border-border px-5 py-[0.6rem] text-[0.8rem] text-faint">
          <a href={base + encodePath(v.history)} {...NEW_TAB}>
            {v.history.split("/").pop()}
          </a>
        </div>
      </DialogContent>
    </Dialog>
  );
}
