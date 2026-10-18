// A model's page: every variant, in full.
// Tuning binds to the optimized variant: a model may have several, each
// against its own baseline, so each optimized variant carries its own results.
import { Fragment, type ReactNode } from "react";
import {
  Link,
  useLoaderData,
  useLocation,
  useNavigate,
  useSearchParams,
  type LoaderFunctionArgs,
  type ShouldRevalidateFunctionArgs,
} from "react-router";
import type { Model, Tuning, Variant } from "@/types";
import { anchorOf, encodePath, orderedVariants, reportLinks, REPORT_LANG, tuningFor, UPLIFT_HELP, WORKLOAD_NAMES } from "@/lib/catalog";
import { catalogLoaded, loadCatalog, loadVariantText } from "@/lib/data";
import { useHost, useTitle } from "@/lib/host";
import { countBy } from "@/lib/facets";
import { tagHue } from "@/lib/hues";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Bar,
  chartCode,
  DeprecatedBadge,
  Fact,
  GpuToggles,
  Hardware,
  imageCode,
  NEW_TAB,
  Topology,
  TopologyToggles,
  VariantBadges,
} from "@/components/catalog";
import { VariantHistory } from "@/components/history";
import { DeleteVariant, EditMetadata, EditVariant, NewVariant, useEditable } from "@/components/edit";
import { icons } from "@/components/icons";
import { SiteFooter, SiteHeader } from "@/components/site";

export const modelLoader =
  (base: string) =>
  async ({ params }: LoaderFunctionArgs) => {
    const catalog = await loadCatalog(base);
    const m = catalog.models.find((x) => x.name === params.dir);
    if (!m) throw new Response(`No model ${params.dir} in this catalog.`, { status: 404 });
    // Each variant's configuration is its own file.
    const texts = await Promise.all(m.variants.map((v) => loadVariantText(base, v)));
    return { m, repo: catalog.repo, yaml: Object.fromEntries(m.variants.map((v, i) => [v.id, texts[i]])) as Record<string, string | null> };
  };

// The GPU filter only changes the query: the model and its files stay, until
// a write changes them.
export const keepModel =
  (base: string) =>
  ({ currentParams, nextParams }: ShouldRevalidateFunctionArgs) =>
    currentParams.dir !== nextParams.dir || !catalogLoaded(base);

// A pair's baseline: linked when the model still has it -- an old pair may
// name one since deleted.
function BaselineRef({ m, t }: { m: Model; t: Tuning }) {
  const code = <code>{t.baselineId}</code>;
  return m.variants.some((v) => v.id === t.baselineId) ? <Link to={{ hash: anchorOf(t.baselineId) }}>{code}</Link> : code;
}

// One bar per workload, drawn against the model's largest result so bars
// compare across its variants. The best row is bold; a regression draws no bar.
//   Agent long-context  ██████████  +64.2%
//   Document QA         █            +7.6%
function TuningBars({ t, scale }: { t: Tuning; scale: number }) {
  const rows = t.workloads.length
    ? t.workloads
    : t.upliftPct == null
      ? []
      : [{ name: "headline", upliftPct: t.upliftPct, upliftLabel: t.upliftLabel! }];
  const best = Math.max(...rows.map((w) => w.upliftPct));
  return (
    <div
      className="mt-[0.6rem] grid grid-cols-[auto_minmax(60px,320px)_minmax(4.6em,auto)] items-center justify-start gap-x-3 gap-y-[0.35rem]"
      title={UPLIFT_HELP}
    >
      {rows.map((w) => {
        const named = WORKLOAD_NAMES[w.name];
        return (
          <div key={w.name} className="col-span-full grid grid-cols-subgrid items-center" title={named ? `${w.name} tokens, in + out` : undefined}>
            <span className="font-mono text-[0.78rem] whitespace-nowrap text-muted-foreground">{named || w.name}</span>
            <Bar pct={Math.max(0, Math.min(100, (w.upliftPct / scale) * 100))} />
            <span className={cn("text-right text-[0.88rem] text-foreground tabular-nums", w.upliftPct === best && "font-bold")}>{w.upliftLabel}</span>
          </div>
        );
      })}
    </div>
  );
}

function TuningBlock({ m, v, t, scale }: { m: Model; v: Variant; t: Tuning; scale: number }) {
  const { base } = useHost();
  const older = t.optimizedVersion !== v.version ? t.optimizedVersion : null;
  return (
    <div className="mt-[0.85rem] rounded-lg border border-border px-[0.85rem] py-3 max-[719px]:px-[0.7rem] max-[719px]:py-[0.65rem]">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-[0.3rem] text-[0.88rem]">
        <span>
          Improvement vs <BaselineRef m={m} t={t} />
          <span className="text-[0.8rem] text-faint"> · per workload</span>
        </span>
        {t.reportFile && (
          <Button variant="link" size="none" className="text-[0.84rem]" asChild>
            <a href={base + encodePath(t.report!) + REPORT_LANG} title={older ? `Measured on v${older}` : undefined} {...NEW_TAB}>
              {icons.report}Perf report
            </a>
          </Button>
        )}
      </div>
      <TuningBars t={t} scale={scale} />
    </div>
  );
}

// A fact stacks its label over its value.
const fact = {
  dt: "text-[0.72rem] tracking-[0.04em] text-faint uppercase",
  dd: "mt-[0.1rem] text-[0.86rem] wrap-anywhere",
};

function VariantDetail({
  m,
  v,
  repo,
  scale,
  yaml,
  targeted,
  editable,
}: {
  m: Model;
  v: Variant;
  repo: string | null;
  scale: number;
  yaml: string | null;
  targeted: boolean;
  editable: boolean;
}) {
  const anchor = anchorOf(v.id);
  const pairs = tuningFor(m, v.id);
  // Optimized variants measured against this one.
  const against = m.variants.filter((o) => tuningFor(m, o.id).some((t) => t.baselineId === v.id));
  return (
    <Card
      id={anchor}
      data-target={targeted || undefined}
      className={cn(
        "block scroll-mt-4 rounded-xl border-[color-mix(in_oklab,var(--border)_35%,var(--input))]",
        "data-target:border-primary data-target:bg-accent",
        // Phones: edge to edge, text lined up with the page's, so the facts
        // and bars get the whole screen width.
        "max-[719px]:-mx-4 max-[719px]:rounded-none max-[719px]:border-x-0 max-[719px]:px-4 max-[719px]:py-4",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-[0.35rem]">
        <h3 className="font-mono text-[0.95rem] font-semibold wrap-anywhere">
          <Link className="text-inherit" to={{ hash: anchor }}>
            {v.id}
          </Link>
        </h3>
        <VariantBadges v={v} />
        <span className="ml-auto flex gap-[0.4rem]">
          {v.link && (
            <Button size="sm" asChild>
              <a href={v.link} {...NEW_TAB}>
                {icons.external}Link
              </a>
            </Button>
          )}
          {/* A write changes the history: it is read again. */}
          <VariantHistory key={v.digest} m={m} v={v} repo={repo} />
          {v.source && (
            <Button size="sm" asChild>
              <a href={v.source} {...NEW_TAB} title={`Pinned to commit ${v.source.split("/blob/")[1].slice(0, 7)}`}>
                {icons.external}Source
              </a>
            </Button>
          )}
          {editable && (
            <>
              <EditVariant m={m} v={v} />
              <DeleteVariant m={m} v={v} />
            </>
          )}
        </span>
      </div>
      {v.description && <p className="mt-[0.45rem] text-[0.9rem] text-muted-foreground">{v.description}</p>}
      <dl className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-x-5 gap-y-2">
        <Fact label="Version" {...fact}>
          <span className="tabular-nums">{v.version}</span>
          {v.releaseDate && <span className="text-faint"> · released {v.releaseDate}</span>}
        </Fact>
        <Fact label="Engine" {...fact}>
          {v.engine}
        </Fact>
        <Fact label="Hardware" {...fact}>
          {v.hardwareShort && (
            <>
              <Hardware v={v} />
              <span className="text-faint"> · {v.requiresSummary}</span>
            </>
          )}
        </Fact>
        <Fact label="Topology" {...fact}>
          <Topology v={v} />
        </Fact>
        <Fact label="Chart" {...fact}>
          {chartCode(v)}
        </Fact>
        <Fact label="Image" {...fact}>
          {imageCode(v)}
        </Fact>
        <Fact label="Served as" {...fact}>
          {v.servedName && <code>{v.servedName}</code>}
        </Fact>
      </dl>
      {pairs.map((t) => (
        <TuningBlock key={`${t.optimizedVersion}:${t.baselineId}:${t.reportFile}`} m={m} v={v} t={t} scale={scale} />
      ))}
      {against.length > 0 && (
        <p className="mt-3 text-[0.86rem] text-muted-foreground">
          Baseline for{" "}
          {against.map((o, i) => (
            <Fragment key={o.id}>
              {i > 0 && ", "}
              <Link to={{ hash: anchorOf(o.id) }}>
                <code>{o.id}</code>
              </Link>
            </Fragment>
          ))}
        </p>
      )}
      {yaml && (
        <Collapsible className="mt-[0.85rem]">
          <CollapsibleTrigger className="group flex w-full items-center gap-[0.35rem] text-left text-[0.86rem] text-muted-foreground">
            {/* A disclosure triangle, as a <details> has. */}
            <svg viewBox="0 0 10 10" className="size-[0.55rem] transition-transform group-data-[state=open]:rotate-90" aria-hidden="true">
              <path d="M0 0l10 5-10 5z" fill="currentColor" />
            </svg>
            Configuration
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-2 max-h-[32rem] overflow-auto rounded-md border border-border bg-muted px-[0.9rem] py-3 text-[0.8rem] leading-[1.5]">
              <code>{yaml}</code>
            </pre>
          </CollapsibleContent>
        </Collapsible>
      )}
    </Card>
  );
}

// What a new recipe starts as: a copy of the model's default, or its first.
function newFrom(m: Model, yaml: Record<string, string | null>) {
  const v = [...m.variants].sort((a, b) => Number(b.default) - Number(a.default)).find((x) => yaml[x.id]);
  return v ? { id: v.id, yaml: yaml[v.id]! } : null;
}

// The model's facts on a centered line, a dot between each.
function Facts({ items }: { items: ReactNode[] }) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-[0.6rem] gap-y-[0.3rem] text-[0.86rem] text-muted-foreground">
      {items.map((x, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <span aria-hidden="true" className="text-faint">
              ·
            </span>
          )}
          {x}
        </Fragment>
      ))}
    </div>
  );
}

export function ModelRoute() {
  const { m, repo, yaml } = useLoaderData() as Awaited<ReturnType<ReturnType<typeof modelLoader>>>;
  const variants = orderedVariants(m);
  const { hash } = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { base } = useHost();
  const editable = useEditable();
  useTitle(`${m.displayName} · Model Catalog`);

  // Checked GPU and topology toggles show only the variants on one of them,
  // each filter's own; the choice lives in the query, beside the fragment. A
  // model on one GPU, or one topology, has nothing to filter there, so no
  // toggles.
  const gpus = countBy(m.variants.flatMap((v) => [...new Set(v.hardware)]));
  const topologies = countBy(m.variants.map((v) => v.topology));
  const selected = {
    hardware: params.getAll("hardware").filter((h) => h in gpus),
    topology: params.getAll("topology").filter((t) => t in topologies),
  };
  const select = (key: keyof typeof selected) => (values: string[]) => {
    const next = { ...selected, [key]: values };
    const query = new URLSearchParams();
    for (const h of next.hardware) query.append("hardware", h);
    for (const t of next.topology) query.append("topology", t);
    navigate({ search: query.toString(), hash }, { replace: true, preventScrollReset: true });
  };
  const filtered = selected.hardware.length > 0 || selected.topology.length > 0;
  const shows = (v: Variant) =>
    (!selected.hardware.length || selected.hardware.some((h) => v.hardware.includes(h))) &&
    (!selected.topology.length || selected.topology.includes(v.topology));

  const all = m.variants
    .flatMap((v) => tuningFor(m, v.id))
    .flatMap((t) => (t.workloads.length ? t.workloads.map((w) => w.upliftPct) : [t.upliftPct]));
  const scale = Math.max(0, ...all.filter((x): x is number => x != null)) || 1;
  const hf = m.source && m.source.hf;
  const filterLink = (field: string, value: string, hue: string) => (
    <Badge key={value} variant="chip" className={hue} asChild>
      <Link to={{ pathname: "/", search: `?${field}=${encodeURIComponent(value)}` }} title={`All recipes with ${field} ${value}`}>
        {value}
      </Link>
    </Badge>
  );
  const reports = reportLinks(m, "Perf report");
  const total = m.variants.length;
  const shown = m.variants.filter(shows).length;
  const noun = total === 1 ? "recipe" : "recipes";

  return (
    <>
      <SiteHeader
        eyebrow={
          <>
            <Link to="/">model-catalog</Link> / {m.name}
          </>
        }
        title={
          <>
            {m.displayName} <DeprecatedBadge m={m} className="align-[2px]" />
          </>
        }
        description={m.description}
      >
        {m.deprecatedReason && <p className="text-[0.9rem] text-destructive">Deprecated: {m.deprecatedReason}</p>}
        <Facts
          items={[
            <code key="name">{m.name}</code>,
            m.family && filterLink("family", m.family, ""),
            hf && (
              <span key="hf">
                <a href={`https://huggingface.co/${hf}`} {...NEW_TAB}>
                  <code>{hf}</code>
                </a>
                {m.source!.revision && (
                  <>
                    {" @ "}
                    <code>{m.source!.revision}</code>
                  </>
                )}
              </span>
            ),
          ].filter(Boolean)}
        />
        {m.tags.length > 0 && (
          <div className="flex flex-wrap justify-center gap-[0.3rem]">{m.tags.map((t) => filterLink("tag", t, `hue-${tagHue(t)}`))}</div>
        )}
        {editable && (
          <div className="flex flex-wrap justify-center gap-2">
            <NewVariant m={m} from={newFrom(m, yaml)} />
            <EditMetadata m={m} />
          </div>
        )}
        {reports.length > 0 && (
          <div className="flex flex-wrap justify-center gap-2">
            {reports.map(({ r, title, text }) => (
              <Button key={r.file} asChild>
                <a href={base + encodePath(r.path) + REPORT_LANG} title={title} {...NEW_TAB}>
                  {icons.report}
                  {text}
                </a>
              </Button>
            ))}
          </div>
        )}
      </SiteHeader>
      <main className="wrap">
        <section id="recipes">
          <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border px-[0.1rem] pb-2">
            <h2 className="text-[1.05rem] font-bold tabular-nums">Recipes</h2>
            <span className="text-[0.84rem] text-muted-foreground">
              <span>{filtered ? `${shown} of ${total} ${noun}` : `${total} ${noun}`}</span>
            </span>
          </div>
          {(Object.keys(gpus).length > 1 || Object.keys(topologies).length > 1) && (
            <div className="mb-4 grid gap-2">
              {Object.keys(gpus).length > 1 && (
                <GpuToggles counts={gpus} what="Recipes for" selected={selected.hardware} onChange={select("hardware")} />
              )}
              {Object.keys(topologies).length > 1 && (
                <TopologyToggles counts={topologies} what="Recipes for" selected={selected.topology} onChange={select("topology")} />
              )}
            </div>
          )}
          <div className="grid gap-[0.85rem]">
            {variants.filter(shows).map((v) => (
              <VariantDetail
                key={v.id}
                m={m}
                v={v}
                repo={repo}
                scale={scale}
                yaml={yaml[v.id]?.replace(/\s+$/, "") || null}
                targeted={hash === `#${anchorOf(v.id)}`}
                editable={editable}
              />
            ))}
          </div>
        </section>
      </main>
      <SiteFooter>
        Generated from <code>models/{m.name}/</code> by <code>npm run build:site</code>.
      </SiteFooter>
    </>
  );
}
