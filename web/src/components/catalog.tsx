// Pieces every page shows a model or variant with.
import { Fragment, useState, type ReactElement, type ReactNode } from "react";
import { Link } from "react-router";
import { ChevronDownIcon } from "lucide-react";
import type { Model, Variant } from "@/types";
import { anchorOf, encodePath, modelPath, reportLinks, REPORT_LANG, topologyLabel, UPLIFT_HELP, variantBest } from "@/lib/catalog";
import { computeSummary, type Facet } from "@/lib/facets";
import { gpuGroup, gpuHue, tagHue, topologyHue } from "@/lib/hues";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { icons } from "./icons";

export const none = <span className="text-faint">—</span>;

// Links open in a new tab, so the catalog stays where it was.
export const NEW_TAB = { target: "_blank", rel: "noopener" } as const;

// The site's root, where the published files are: index-v2.json and its
// variant files, index.json and its version files, and the perf reports.
export const ROOT = import.meta.env.BASE_URL;

// A filter chip: clicking one sets the list's filter (see ListPage). Family
// chips stay neutral, so a family never reads as a tag; GPU names wear the
// same highlight as in hardware lines.
export function Chip({ filter, value }: { filter: "tag" | "family" | "hardware"; value: string }) {
  const hue = filter === "tag" ? `hue-${tagHue(value)}` : filter === "hardware" ? `hue-${gpuHue(value)} font-semibold` : "";
  return (
    <Badge variant="chip" className={hue} asChild>
      <button type="button" data-filter={filter} data-value={value} title={`Filter by ${filter}: ${value}`}>
        {value}
      </button>
    </Badge>
  );
}

export function DeprecatedBadge({ m, className }: { m: Model; className?: string }) {
  if (!m.deprecated) return null;
  return (
    <Badge variant="deprecated" className={className} title={m.deprecatedReason ?? undefined}>
      deprecated
    </Badge>
  );
}

export function VariantBadges({ v }: { v: Variant }) {
  return (
    <>
      {v.default && <Badge variant="quiet">default</Badge>}
      {v.isOptimized && <Badge variant="optimized">optimized</Badge>}
      {v.isBaseline && <Badge variant="quiet">baseline</Badge>}
      {v.deprecated && (
        <Badge variant="deprecated" title={v.deprecatedReason ?? undefined}>
          deprecated
        </Badge>
      )}
    </>
  );
}

// id and badges on one line. The id opens the variant on its model page,
// where its configuration and its source on GitHub are.
export function VariantLine({ m, v, className, idClass }: { m: Model; v: Variant; className: string; idClass?: string }) {
  return (
    <div className={className}>
      <Link
        className={cn("mr-[0.15rem] font-mono text-[0.84rem] wrap-anywhere text-inherit hover:text-primary", idClass)}
        to={{ pathname: modelPath(m), hash: anchorOf(v.id) }}
        title={v.description ? `${v.id}: ${v.description}` : v.id}
      >
        {v.id}
      </Link>
      <VariantBadges v={v} />
    </div>
  );
}

// The id as it heads a line; see VariantLine.
export const variantLine = "flex flex-wrap items-center gap-x-[0.45rem] gap-y-[0.3rem]";
export const tableVariantLine = "flex h-[1.45rem] items-center gap-[0.45rem] whitespace-nowrap [&+&]:mt-[0.35rem]";

const highlight = (label: string) => (
  <Badge variant="gpu" className={`hue-${gpuHue(label)}`}>
    {label}
  </Badge>
);

// hardwareShort with each GPU name marked: "8 × <H100>", highlighted unless
// mark says otherwise. Labels are only GPU names when the variant names
// products; "any GPU" stays plain.
export function Hardware({ v, short = v.hardwareShort, mark = highlight }: { v: Variant; short?: string; mark?: (label: string) => ReactNode }) {
  const labels = v.hardware.filter((label) => label !== "any GPU");
  return (
    <>
      {short.split(/( × | \/ )/).map((part, i) => (
        <Fragment key={i}>{labels.includes(part) ? mark(part) : part}</Fragment>
      ))}
    </>
  );
}

// A variant's topology in its hue, by its label. LeaderWorkerSet opens what
// it is on a click.
export function Topology({ v }: { v: Variant }) {
  const hue = `hue-${topologyHue(v.topology)}`;
  if (v.topology !== "lws") {
    return (
      <Badge variant="gpu" className={hue}>
        {topologyLabel(v.topology)}
      </Badge>
    );
  }
  const n = v.requires?.nodes;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Badge variant="gpu" className={cn(hue, "cursor-help underline decoration-dotted underline-offset-2")} asChild>
          <button type="button" title="What is LeaderWorkerSet?">
            {topologyLabel(v.topology)}
          </button>
        </Badge>
      </PopoverTrigger>
      <PopoverContent className="grid w-[19rem] gap-2 p-3 text-[0.84rem]">
        <p>
          <strong>LeaderWorkerSet</strong> (lws) is a Kubernetes API that runs each replica as one group of pods: here{" "}
          {n ? `${n} pods across ${n} nodes, a leader and ${n - 1} worker${n - 1 === 1 ? "" : "s"}` : "a leader and its workers, across nodes"}.
        </p>
        <a className="inline-flex items-center gap-[0.3rem] justify-self-start" href="https://github.com/kubernetes-sigs/lws" {...NEW_TAB}>
          {icons.external}kubernetes-sigs/lws
        </a>
      </PopoverContent>
    </Popover>
  );
}

// A bar from the left, rounded at the data end, in the improvement's green.
export function Bar({ pct, className }: { pct: number; className?: string }) {
  return (
    <span className={cn("h-2 overflow-hidden rounded-r bg-muted", className)}>
      <span className="block h-full min-w-[2px] rounded-r bg-success" style={{ width: `${pct.toFixed(1)}%` }}></span>
    </span>
  );
}

// An optimized variant's bar and best number, drawn against scale, the best
// result in view; null for any other variant.
export function improvementBar(m: Model, v: Variant, scale: number, className: string): ReactElement | null {
  const b = variantBest(m, v.id);
  if (!b) return null;
  const width = Math.max(0, Math.min(100, (b.upliftPct / scale) * 100));
  const title =
    (b.of > 1 ? `Best of ${b.of} workloads: ` : "") +
    `${b.upliftLabel}${b.name ? ` at ${b.name} tokens` : ""}, ${v.id} vs ${b.t.baselineId}, measured on v${b.t.optimizedVersion}. ` +
    UPLIFT_HELP;
  return (
    <div className={cn("grid grid-cols-[72px_minmax(4.6em,auto)] items-center justify-end gap-x-[0.6rem]", className)} title={title}>
      <Bar pct={width} />
      <span className="text-right text-[0.86rem] font-bold text-foreground tabular-nums">{b.upliftLabel}</span>
    </div>
  );
}

export interface LinkItem {
  // The variant it belongs to: a report's tuned variant, a link's own.
  id: string | null;
  el: ReactElement;
}

// Perf reports, then any variants[].link, as buttons or as inline links.
export function linkItems(m: Model, kind: "button" | "link", reportLabel: string): LinkItem[] {
  const variant = kind === "button" ? "outline" : "link";
  const size = kind === "button" ? "default" : "none";
  const items: LinkItem[] = reportLinks(m, reportLabel).map(({ r, id, title, text }) => ({
    id,
    el: (
      <Button key={r.path} variant={variant} size={size} asChild>
        <a href={ROOT + encodePath(r.path) + REPORT_LANG} title={title} {...NEW_TAB}>
          {icons.report}
          {text}
        </a>
      </Button>
    ),
  }));
  for (const v of m.variants) {
    if (!v.link) continue;
    items.push({
      id: v.id,
      el: (
        <Button key={`link:${v.id}`} variant={variant} size={size} asChild>
          <a href={v.link} {...NEW_TAB}>
            {icons.external}
            {v.id}
          </a>
        </Button>
      ),
    });
  }
  return items;
}

interface TogglesProps {
  counts: Record<string, number>;
  what: string;
  selected: string[];
  onChange: (values: string[]) => void;
}

// Every toggle filter's label. Each label takes the widest one's room, so
// filters on lines of their own start their toggles at the same place.
const TOGGLE_LABELS = ["GPU", "Topology"];

// A toolbar filter: one toggle per value, labeled, each with its count and
// hue, most first unless group says otherwise; name is what a value reads as.
// Anything with any pressed value matches. what says what is counted, for the
// tooltip.
function FilterToggles({
  label,
  hue,
  group = () => 0,
  name = (value) => value,
  counts,
  what,
  selected,
  onChange,
}: TogglesProps & { label: string; hue: (value: string) => string; group?: (value: string) => number; name?: (value: string) => string }) {
  const values = Object.keys(counts).sort((a, b) => group(a) - group(b) || counts[b] - counts[a] || a.localeCompare(b));
  return (
    <ToggleGroup type="multiple" variant="tint" aria-label={label} value={selected} onValueChange={onChange}>
      <span className="mr-[0.3rem] inline-grid text-[0.8rem] font-bold tracking-[0.06em] text-foreground" aria-hidden="true">
        {TOGGLE_LABELS.map((l) => (
          <span key={l} className={cn("[grid-area:1/1]", l !== label && "invisible")}>
            {l}
          </span>
        ))}
      </span>
      {values.map((v) => (
        <ToggleGroupItem key={v} value={v} className={`hue-${hue(v)}`} title={`${what} ${name(v)}`}>
          {name(v)}
          <span className="text-[0.74rem] font-medium tabular-nums opacity-85">{counts[v]}</span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

// The hardware filter: one toggle per GPU, grouped by gpuGroup. counts is per GPU.
export function GpuToggles(props: TogglesProps) {
  return <FilterToggles label="GPU" hue={gpuHue} group={gpuGroup} {...props} />;
}

// The topology filter, alike: single-node, LeaderWorkerSet, prefill/decode-disaggregated. counts is per topology.
export function TopologyToggles(props: TogglesProps) {
  return <FilterToggles label="Topology" hue={topologyHue} name={topologyLabel} {...props} />;
}

// Radix keeps "" for no value at all, so "everything" travels as this.
const ALL = "*";

// A toolbar select over a filter's values, each with how many entries have it;
// "" is everything.
export function FilterSelect({
  label,
  all,
  values,
  value,
  onChange,
  className,
}: {
  label: string;
  all: string;
  values: string[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const counts: Record<string, number> = {};
  for (const v of values) counts[v] = (counts[v] || 0) + 1;
  return (
    <Select value={value || ALL} onValueChange={(v) => onChange(v === ALL ? "" : v)}>
      <SelectTrigger aria-label={label} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{all}</SelectItem>
        <SelectSeparator />
        {Object.keys(counts)
          .sort((a, b) => a.localeCompare(b))
          .map((v) => (
            <SelectItem key={v} value={v} hint={counts[v]}>
              {v}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
}

export interface FilterOption {
  value: string;
  label: string;
  count: number;
  // A GPU's or topology's hue: the label then wears it, as in hardware lines.
  hue?: string;
}

// A table column's filter: its header opens the column's values to check,
// each with how many entries have it. Anything with a checked value matches;
// none checked is everything. A long list gets a search.
export function ColumnFilter({
  label,
  options,
  selected,
  onChange,
  className,
}: {
  label: string;
  options: FilterOption[];
  selected: string[];
  onChange: (values: string[]) => void;
  className?: string;
}) {
  const [q, setQ] = useState("");
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = options.filter((o) => terms.every((t) => `${o.value} ${o.label}`.toLowerCase().includes(t)));
  const name = label.toLowerCase();
  const active = selected.length > 0;
  return (
    <Popover onOpenChange={(open) => open || setQ("")}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={active ? `${label} filter, ${selected.length} selected` : `${label} filter`}
          title={active ? `${label}: ${selected.map((v) => options.find((o) => o.value === v)?.label ?? v).join(", ")}` : `Filter by ${name}`}
          data-active={active || undefined}
          className={cn(
            "group -ml-[0.3rem] inline-flex min-h-[1.5rem] items-center gap-[0.3rem] rounded-sm px-[0.3rem] hover:bg-accent hover:text-foreground data-active:text-primary data-[state=open]:bg-accent data-[state=open]:text-foreground",
            className,
          )}
        >
          {label}
          {active && (
            <span className="rounded-sm bg-accent px-[0.3rem] text-[0.7rem] leading-[1.4] text-primary tabular-nums">{selected.length}</span>
          )}
          <ChevronDownIcon aria-hidden="true" className="size-[0.85rem] transition-transform duration-150 group-data-[state=open]:rotate-180" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="flex w-[17rem] flex-col font-normal">
        {options.length > 8 && (
          <div className="border-b border-border p-[0.4rem]">
            <Input
              type="search"
              aria-label={`Search ${name}`}
              placeholder={`Search ${name}…`}
              autoComplete="off"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="min-h-8 py-1 text-[0.85rem]"
            />
          </div>
        )}
        <div role="group" aria-label={label} className="max-h-72 min-h-0 overflow-y-auto p-1">
          {shown.map((o) => (
            <label
              key={o.value}
              className="flex cursor-pointer items-center gap-[0.6rem] rounded-md px-2 py-[0.35rem] text-[0.88rem] text-foreground hover:bg-accent"
            >
              <input
                type="checkbox"
                className="size-[0.95rem] shrink-0 cursor-pointer accent-primary"
                checked={selected.includes(o.value)}
                onChange={(e) => onChange(e.target.checked ? [...selected, o.value] : selected.filter((v) => v !== o.value))}
              />
              <span className="min-w-0 flex-1 truncate" title={o.label === o.value ? undefined : o.value}>
                {o.hue ? (
                  <Badge variant="gpu" className={`hue-${o.hue}`}>
                    {o.label}
                  </Badge>
                ) : (
                  o.label
                )}
              </span>
              <span className="text-[0.8rem] text-faint tabular-nums">{o.count}</span>
            </label>
          ))}
          {shown.length === 0 && <p className="px-2 py-3 text-center text-[0.85rem] text-muted-foreground">No {name} matches.</p>}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-border px-[0.7rem] py-[0.4rem] text-[0.8rem] text-muted-foreground">
          <span className="tabular-nums">{active ? `${selected.length} of ${options.length} selected` : `All ${options.length}`}</span>
          <Button type="button" variant="ghost" size="none" disabled={!active} onClick={() => onChange([])}>
            Clear
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Stat({ label, value, sub, pos }: { label: string; value: ReactNode; sub?: string; pos?: boolean }) {
  return (
    <Card className="rounded-xl px-4 py-[0.8rem] max-[560px]:snap-start max-[560px]:px-[0.85rem] max-[560px]:py-[0.7rem]">
      <div className="text-[0.78rem] text-muted-foreground">{label}</div>
      <div className={cn("text-[1.45rem] font-[650] tracking-[-0.01em] tabular-nums", pos && "text-success")}>{value}</div>
      <div className="min-h-[1.2em] text-[0.78rem] wrap-anywhere text-faint">{sub || ""}</div>
    </Card>
  );
}

// The summary over what a list shows. On phones it scrolls sideways.
export function Summary({ items }: { items: Facet[] }) {
  const s = computeSummary(items);
  const pct = (x: number) => "+" + (Math.round(x * 10) / 10).toFixed(1) + "%";
  const counts = (o: Record<string, number>) =>
    Object.keys(o)
      .sort((a, b) => o[b] - o[a] || a.localeCompare(b))
      .map((k) => `${k} ${o[k]}`)
      .join(" · ");
  return (
    <section
      aria-label="Summary"
      aria-live="polite"
      className="mb-4 grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-3 max-[560px]:-mx-4 max-[560px]:grid-flow-col max-[560px]:auto-cols-[minmax(132px,40%)] max-[560px]:grid-cols-none max-[560px]:snap-x max-[560px]:snap-proximity max-[560px]:scroll-px-4 max-[560px]:overflow-x-auto max-[560px]:px-4 max-[560px]:pb-[2px] max-[560px]:[scrollbar-width:none] max-[560px]:[&::-webkit-scrollbar]:hidden"
    >
      <Stat label="Models" value={s.models} sub={s.deprecated ? `${s.deprecated} deprecated` : ""} />
      <Stat label="Recipes" value={s.variants} sub={counts(s.engines)} />
      <Stat label="Optimized pairs" value={s.pairs} sub={s.models ? `${Math.round((s.pairs / s.models) * 100)}% of models` : ""} />
      <Stat
        label="Median improvement"
        value={s.median == null ? "—" : pct(s.median)}
        sub={s.median == null ? "" : `${pct(s.worst!.pct)} to ${pct(s.best!.pct)}`}
        pos={s.median != null}
      />
      <Stat label="Best improvement" value={s.best ? pct(s.best.pct) : "—"} sub={s.best ? s.best.name : ""} pos={!!s.best} />
    </section>
  );
}

export function chartCode(v: Variant) {
  return v.chart && v.chart.name ? <code>{`${v.chart.name}${v.chart.version ? ` ${v.chart.version}` : ""}`}</code> : null;
}

export function imageCode(v: Variant) {
  return v.image && v.image.repository ? <code>{`${v.image.repository}${v.image.tag ? `:${v.image.tag}` : ""}`}</code> : null;
}

// One fact of a definition list; nothing when there is no value. The classes
// are the list's: a model page stacks each label over its value, a variant
// card sets them side by side.
export function Fact({ label, children, className, dt, dd }: { label: string; children: ReactNode; className?: string; dt: string; dd: string }) {
  if (!children) return null;
  return (
    <div className={className}>
      <dt className={dt}>{label}</dt>
      <dd className={dd}>{children}</dd>
    </div>
  );
}

// GPU chips, NVIDIA's first.
export function GpuChips({ labels }: { labels: string[] }) {
  return (
    <>
      {[...labels]
        .sort((a, b) => gpuGroup(a) - gpuGroup(b) || a.localeCompare(b))
        .map((h) => (
          <Chip key={h} filter="hardware" value={h} />
        ))}
    </>
  );
}
