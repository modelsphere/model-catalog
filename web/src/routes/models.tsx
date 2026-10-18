// The models list: a legacy page of its own, reached only from the deployment
// recipes' "All models" link. Everything else -- a model page's family and tag
// chips, its breadcrumb, a missing page -- leads back to the recipes.
import { Fragment, memo, useMemo } from "react";
import { Link, useRouteLoaderData } from "react-router";
import type { Catalog, Model } from "@/types";
import { idIsDisplayName, modelPath, orderedVariants, UPLIFT_HELP, variantBest } from "@/lib/catalog";
import { facetsOf } from "@/lib/facets";
import { useHost, useTitle } from "@/lib/host";
import { Card } from "@/components/ui/card";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import {
  Chip,
  DeprecatedBadge,
  GpuChips,
  Hardware,
  improvementBar,
  linkItems,
  none,
  tableVariantLine,
  VariantLine,
  variantLine,
} from "@/components/catalog";
import { ListPage } from "@/components/list-page";
import { NewModel, SetupCatalog, useEditable, useSetupable } from "@/components/edit";

const ModelCard = memo(function ModelCard({ m, scale, hidden }: { m: Model; scale: number; hidden: boolean }) {
  const { base } = useHost();
  const links = linkItems(base, m, "button", "Perf report");
  return (
    <Card hidden={hidden} className="max-[560px]:p-4">
      <h2 className="text-[1.1rem] font-[650] tracking-[-0.01em]">
        <Link className="text-inherit hover:text-primary" to={modelPath(m)} title={m.name}>
          {m.displayName}
        </Link>{" "}
        <DeprecatedBadge m={m} className="ml-1 align-[2px]" />
      </h2>
      <div className="mt-[0.2rem] flex flex-wrap items-center gap-x-[0.6rem] gap-y-[0.3rem] text-[0.84rem] text-muted-foreground">
        {!idIsDisplayName(m) && <code>{m.name}</code>}
        {m.family && <Chip filter="family" value={m.family} />}
      </div>
      <div className="mt-3 flex flex-1 flex-col gap-[0.9rem]">
        <div>
          {m.description && (
            <p className="line-clamp-3 text-[0.9rem] text-muted-foreground" title={m.description}>
              {m.description}
            </p>
          )}
        </div>
        {/* Content stays top-aligned; links sit at the bottom so a row's buttons line up. */}
        <div className="flex flex-1 flex-col">
          <ul aria-label="Recipes" className="rounded-lg border border-border">
            {orderedVariants(m).map((v) => {
              // Cards are narrow, so hardware leads the description line
              // instead of wrapping onto a line of its own.
              const hw = v.hardwareShort ? (
                <span className="font-medium text-foreground tabular-nums" title={v.requiresSummary}>
                  <Hardware v={v} />
                </span>
              ) : null;
              const bar = improvementBar(m, v, scale, "h-[1.35rem] shrink-0 grid-cols-[56px_minmax(4.4em,auto)]");
              const line = <VariantLine m={m} v={v} className={variantLine} />;
              return (
                <li key={v.id} className="px-[0.8rem] py-[0.6rem] [&+&]:border-t [&+&]:border-border">
                  {bar ? (
                    <div className="flex items-start gap-x-3 gap-y-2 [&>div:first-child]:min-w-0 [&>div:first-child]:flex-1">
                      {line}
                      {bar}
                    </div>
                  ) : (
                    line
                  )}
                  {(hw || v.description) && (
                    <div className="mt-[0.2rem] line-clamp-2 text-[0.8rem] text-faint" title={v.description ?? undefined}>
                      {hw}
                      {hw && v.description ? " · " : ""}
                      {v.description}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {links.length > 0 && <div className="mt-auto flex flex-wrap gap-2 pt-3">{links.map((x) => x.el)}</div>}
        </div>
      </div>
    </Card>
  );
});

const lineRow = "h-[1.45rem] [&+&]:mt-[0.35rem]";

// The table's improvement cell: one row per variant line, so each optimized
// variant's bar sits on its own line and the rest stay blank.
function improvementCell(m: Model, scale: number) {
  const variants = orderedVariants(m);
  const bars = variants.map((v) => improvementBar(m, v, scale, lineRow));
  if (!bars.some(Boolean)) return null;
  return (
    <>
      {bars.map((b, i) => (
        <Fragment key={variants[i].id}>{b ?? <div className={lineRow} aria-hidden="true"></div>}</Fragment>
      ))}
    </>
  );
}

// The table's links sit on the row of the variant each belongs to, like the
// bars beside them; any no listed variant owns go below.
function linksCell(base: string, m: Model) {
  const items = linkItems(base, m, "link", "Report");
  if (!items.length) return null;
  const variants = orderedVariants(m);
  const ids = new Set(variants.map((v) => v.id));
  const rest = items.filter((x) => !ids.has(x.id ?? "")).map((x) => x.el);
  const restList = "grid justify-items-start gap-[0.2rem]";
  if (rest.length === items.length) return <div className={restList}>{rest}</div>;
  return (
    <>
      {variants.map((v) => (
        <div key={v.id} className={`${lineRow} flex items-center gap-3`} aria-hidden={items.some((x) => x.id === v.id) ? undefined : true}>
          {items.filter((x) => x.id === v.id).map((x) => x.el)}
        </div>
      ))}
      {rest.length > 0 && <div className={`${restList} mt-[0.35rem]`}>{rest}</div>}
    </>
  );
}

// Compact: no descriptions (the description is the name's tooltip).
const ModelRow = memo(function ModelRow({ m, scale, hidden }: { m: Model; scale: number; hidden: boolean }) {
  const { base } = useHost();
  const gpus = [...new Set(m.variants.flatMap((v) => v.hardware))];
  return (
    <TableRow hidden={hidden}>
      <TableCell className="min-w-[200px]">
        <div className="font-semibold" title={m.description ? `${m.name} — ${m.description}` : m.name}>
          <Link className="text-inherit hover:text-primary" to={modelPath(m)}>
            {m.displayName}
          </Link>{" "}
          <DeprecatedBadge m={m} className="ml-[0.2rem] align-[1px]" />
        </div>
        {!idIsDisplayName(m) && (
          <div className="mt-[0.1rem] text-[0.8rem] text-muted-foreground">
            <code>{m.name}</code>
          </div>
        )}
        {gpus.length > 0 && (
          <div className="mt-[0.35rem] flex flex-wrap gap-[0.3rem]">
            <GpuChips labels={gpus} />
          </div>
        )}
      </TableCell>
      <TableCell>{m.family ? <Chip filter="family" value={m.family} /> : none}</TableCell>
      <TableCell>
        {orderedVariants(m).map((v) => (
          <VariantLine key={v.id} m={m} v={v} className={tableVariantLine} idClass="text-[0.82rem]" />
        ))}
      </TableCell>
      <TableCell className="text-right">{improvementCell(m, scale) || none}</TableCell>
      <TableCell>{linksCell(base, m) || none}</TableCell>
    </TableRow>
  );
});

export function ModelsRoute() {
  const catalog = useRouteLoaderData("root") as Catalog;
  const editable = useEditable();
  const setupable = useSetupable();
  useTitle("Models · Model Catalog");
  const models = catalog.models;
  const { facets, scale } = useMemo(
    () => ({
      facets: models.map(facetsOf),
      // Every bar is drawn against the catalog's best result.
      scale: Math.max(0, ...models.flatMap((m) => m.variants.map((v) => variantBest(m, v.id)?.upliftPct || 0))) || 1,
    }),
    [models],
  );
  return (
    <ListPage
      cfg={{
        header: {
          eyebrow: <Link to="/">model-catalog</Link>,
          title: "Models",
          description: "Every model in the catalog: its recipes, the GPUs they need, and the tuned recipe's improvement over its baseline.",
          children: setupable ? <SetupCatalog /> : editable && <NewModel />,
        },
        noun: "models",
        facets,
        search: "Search models, recipes, hardware…",
        sorts: [
          ["uplift", "Sort by improvement"],
          ["name", "Sort by name"],
          ["family", "Sort by family"],
        ],
        gpuWhat: "Models with a recipe for",
        cardWidth: 420,
        head: (th) => (
          <>
            {th("name", "Model", { filter: "model" })}
            {th("family", "Family")}
            <TableHead>Recipes</TableHead>
            {th("uplift", "Improvement vs baseline", { className: "text-right", title: UPLIFT_HELP, sub: "best workload" })}
            <TableHead>Links</TableHead>
          </>
        ),
        card: (i, hidden) => <ModelCard key={i} m={models[i]} scale={scale} hidden={hidden} />,
        row: (i, hidden) => <ModelRow key={i} m={models[i]} scale={scale} hidden={hidden} />,
      }}
    />
  );
}
