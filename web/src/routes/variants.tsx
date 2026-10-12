// The deployment recipes, the catalog's front page: every model's variants in
// the version a deploy gets, one entry each, so they compare across models: by
// GPU, engine, image or improvement.
import { memo, useEffect, useMemo } from "react";
import { Link, useRouteLoaderData } from "react-router";
import type { Catalog, Model, Variant } from "@/types";
import { latestVersion, modelPath, orderedVariants, UPLIFT_HELP } from "@/lib/catalog";
import { variantFacetsOf } from "@/lib/facets";
import { Card } from "@/components/ui/card";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import {
  chartCode,
  Chip,
  DeprecatedBadge,
  Fact,
  Hardware,
  imageCode,
  improvementBar,
  linkItems,
  NEW_TAB,
  none,
  tableVariantLine,
  VariantLine,
  variantLine,
} from "@/components/catalog";
import { ListPage } from "@/components/list-page";

// A variant's own perf reports and link.
function variantLinks(m: Model, v: Variant, kind: "button" | "link", reportLabel: string) {
  return linkItems(m, kind, reportLabel)
    .filter((x) => x.id === v.id)
    .map((x) => x.el);
}

// Engine, image and chart, each label beside its value.
const fact = {
  className: "contents",
  dt: "text-[0.7rem] tracking-[0.04em] text-faint uppercase",
  dd: "wrap-anywhere",
};

const VariantCard = memo(function VariantCard({ m, v, scale, hidden }: { m: Model; v: Variant; scale: number; hidden: boolean }) {
  const hw = v.hardwareShort ? (
    <span className="font-medium text-foreground tabular-nums" title={v.requiresSummary}>
      <Hardware v={v} />
    </span>
  ) : null;
  const line = <VariantLine m={m} v={v} className={variantLine} idClass="text-[0.92rem] font-semibold" />;
  const bar = improvementBar(m, v, scale, "h-[1.35rem] shrink-0 grid-cols-[56px_minmax(4.4em,auto)]");
  const links = variantLinks(m, v, "button", "Perf report");
  return (
    <Card hidden={hidden} className="gap-[0.45rem] max-[560px]:p-4">
      <div className="flex flex-wrap items-center gap-x-[0.6rem] gap-y-[0.3rem] text-[0.84rem] text-muted-foreground">
        <Link className="font-semibold text-foreground hover:text-primary" to={modelPath(m)} title={m.name}>
          {m.displayName}
        </Link>
        <DeprecatedBadge m={m} />
        {m.family && <Chip filter="family" value={m.family} />}
      </div>
      {bar ? (
        <div className="flex items-start gap-x-3 gap-y-2 [&>div:first-child]:min-w-0 [&>div:first-child]:flex-1">
          {line}
          {bar}
        </div>
      ) : (
        line
      )}
      {(hw || v.description) && (
        <div className="line-clamp-2 text-[0.8rem] text-faint" title={v.description ?? undefined}>
          {hw}
          {hw && v.description ? " · " : ""}
          {v.description}
        </div>
      )}
      <dl className="mt-[0.1rem] grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-[0.15rem] text-[0.84rem]">
        <Fact label="Engine" {...fact}>
          {v.engine}
        </Fact>
        <Fact label="Image" {...fact}>
          {imageCode(v)}
        </Fact>
        <Fact label="Chart" {...fact}>
          {chartCode(v)}
        </Fact>
      </dl>
      {links.length > 0 && <div className="mt-auto flex flex-wrap gap-2 pt-[0.35rem]">{links}</div>}
    </Card>
  );
});

// Hardware with its GPU names as filter chips. A node count may wrap to a
// line of its own; the rest stays on one.
function HardwareCell({ v }: { v: Variant }) {
  const [, gpus, nodes] = v.hardwareShort.match(/^(.*?)(?: (× \d+ nodes))?$/)!;
  return (
    <>
      <span className="whitespace-nowrap">
        <Hardware v={v} short={gpus} mark={(label) => <Chip filter="hardware" value={label} />} />
      </span>
      {nodes && (
        <>
          {" "}
          <span className="whitespace-nowrap">{nodes}</span>
        </>
      )}
    </>
  );
}

// The table: the model first, since many models share variant ids
// (sglang-tp8-h100-baseline); the engine and image under the id.
const VariantRow = memo(function VariantRow({ m, v, scale, hidden }: { m: Model; v: Variant; scale: number; hidden: boolean }) {
  const image = imageCode(v);
  const links = variantLinks(m, v, "link", "Report");
  return (
    <TableRow hidden={hidden}>
      <TableCell className="min-w-[200px]">
        <div className="font-semibold" title={m.name}>
          <Link className="text-inherit hover:text-primary" to={modelPath(m)}>
            {m.displayName}
          </Link>{" "}
          <DeprecatedBadge m={m} className="ml-[0.2rem] align-[1px]" />
        </div>
        {m.family && (
          <div className="mt-[0.35rem] flex flex-wrap gap-[0.3rem]">
            <Chip filter="family" value={m.family} />
          </div>
        )}
      </TableCell>
      <TableCell>
        <VariantLine m={m} v={v} className={tableVariantLine} idClass="text-[0.82rem]" />
        {(v.engine || image) && (
          <div className="mt-[0.1rem] text-[0.8rem] text-muted-foreground">
            {v.engine}
            {v.engine && image ? " · " : ""}
            {image}
          </div>
        )}
      </TableCell>
      <TableCell className="tabular-nums" title={v.requiresSummary || undefined}>
        {v.hardwareShort ? <HardwareCell v={v} /> : none}
      </TableCell>
      <TableCell className="text-right">{improvementBar(m, v, scale, "h-[1.45rem]") || none}</TableCell>
      <TableCell>{links.length ? <div className="grid justify-items-start gap-[0.2rem]">{links}</div> : none}</TableCell>
    </TableRow>
  );
});

export function VariantsRoute() {
  const catalog = useRouteLoaderData("root") as Catalog;
  useEffect(() => {
    document.title = "Model Catalog";
  }, []);
  const { entries, facets, scale } = useMemo(() => {
    const entries = catalog.models.flatMap((m) => orderedVariants(m, latestVersion(m).variants).map((v, rank) => ({ m, v, rank })));
    const facets = entries.map(({ m, v, rank }) => variantFacetsOf(m, v, rank));
    // Every bar is drawn against the best result on the page.
    return { entries, facets, scale: Math.max(0, ...facets.map((f) => f.uplift || 0)) || 1 };
  }, [catalog]);
  return (
    <ListPage
      cfg={{
        header: {
          title: (
            <>
              Model <em>catalog</em>
            </>
          ),
          // Two lines: where deploying is done, then what is here.
          description: (
            <>
              <span className="block">
                For the deployment solution, see{" "}
                <a href="https://github.com/modelsphere/modelsphere" {...NEW_TAB}>
                  modelsphere
                </a>
                .
              </span>
              <span className="block">
                The models{" "}
                <a href="https://github.com/modelsphere/swiss" {...NEW_TAB}>
                  swiss
                </a>{" "}
                can deploy, and how to serve each one: engine, image, flags, GPUs and tuned variants.
              </span>
            </>
          ),
        },
        heading: (
          <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border px-[0.1rem] pb-2">
            <h2 className="text-[1.05rem] font-bold">Deployment Recipe</h2>
            <span className="text-[0.84rem] text-muted-foreground max-[560px]:hidden">every model's recipes, in the version a deploy gets</span>
            <Link to="/models.html" className="ml-auto inline-flex items-baseline gap-[0.4rem] text-[0.88rem] font-semibold">
              All models
              <span className="text-[0.8rem] font-medium text-faint tabular-nums">{catalog.count}</span>
              <span aria-hidden="true">→</span>
            </Link>
          </div>
        ),
        noun: "recipes",
        facets,
        search: "Search recipes, models, images, hardware…",
        sorts: [
          ["uplift", "Sort by improvement"],
          ["name", "Sort by model"],
          ["family", "Sort by family"],
          ["gpus", "Sort by GPUs"],
        ],
        gpuWhat: "Recipes for",
        cardWidth: 360,
        head: (th) => (
          <>
            {th("name", "Model", { filter: "model" })}
            <TableHead>
              Recipe<span className="mt-[0.1rem] block text-[0.68rem] font-normal text-faint">engine · image</span>
            </TableHead>
            {th("gpus", "Hardware", { filter: "hardware" })}
            {th("uplift", "Improvement vs baseline", { className: "text-right", title: UPLIFT_HELP, sub: "best workload" })}
            <TableHead>Links</TableHead>
          </>
        ),
        card: (i, hidden) => <VariantCard key={i} m={entries[i].m} v={entries[i].v} scale={scale} hidden={hidden} />,
        row: (i, hidden) => <VariantRow key={i} m={entries[i].m} v={entries[i].v} scale={scale} hidden={hidden} />,
      }}
    />
  );
}
