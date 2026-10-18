// What every page has around its content: the header, with the logo, the
// GitHub links and the theme button, and the footer.
import { useEffect, useState, type ReactNode } from "react";
import { Link, useRouteLoaderData } from "react-router";
import { StarIcon } from "lucide-react";
import type { Catalog } from "@/types";
import { useHost } from "@/lib/host";
import { Button } from "@/components/ui/button";
import { icons } from "./icons";

type Theme = "system" | "light" | "dark";
const THEMES: Theme[] = ["system", "light", "dark"];

// Cycles system -> light -> dark. The choice is stored per browser; the boot
// script in index.html applies it before first paint.
function ThemeButton() {
  const { root: html } = useHost();
  const [theme, setTheme] = useState<Theme>(() => (html.dataset.theme as Theme) || "system");
  const next = () => {
    const t = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    if (t === "system") delete html.dataset.theme;
    else html.dataset.theme = t;
    try {
      if (t === "system") localStorage.removeItem("theme");
      else localStorage.setItem("theme", t);
    } catch {
      // Storage can be unavailable (private mode); the toggle still works for this visit.
    }
    setTheme(t);
  };
  return (
    <Button type="button" id="theme-toggle" title={`Theme: ${theme} (click to change)`} onClick={next} className={topButton}>
      {THEMES.map((t) => (
        <span key={t} data-icon={t} hidden={t !== theme} className="inline-flex">
          {icons[t]}
        </span>
      ))}
      <span className="max-[560px]:hidden">{theme[0].toUpperCase() + theme.slice(1)}</span>
    </Button>
  );
}

// The header's top-right buttons share one look.
const topButton = "gap-[0.4rem] px-3 py-[0.4rem] text-[0.85rem] text-muted-foreground hover:border-input hover:text-foreground [&_svg]:size-4";

// A repository's stars, asked of GitHub once per visit; null until known,
// or when GitHub will not say (rate limit, offline, a repository elsewhere):
// the link shows without.
const starsAsked = new Map<string, Promise<number | null>>();
const onGitHub = (repo: string) => repo.startsWith("https://github.com/");
// Kept with the repository they are of: the repository can change under the
// link, when the catalog is set up or edited.
function useStars(repo: string): number | null {
  const [stars, setStars] = useState<{ repo: string; n: number | null } | null>(null);
  useEffect(() => {
    if (!onGitHub(repo)) return;
    let live = true;
    let asked = starsAsked.get(repo);
    if (!asked) {
      asked = fetch(repo.replace("https://github.com/", "https://api.github.com/repos/"))
        .then((res) => (res.ok ? res.json() : null))
        .then((r) => (typeof r?.stargazers_count === "number" ? r.stargazers_count : null))
        .catch(() => null);
      starsAsked.set(repo, asked);
    }
    asked.then((n) => live && setStars({ repo, n }));
    return () => {
      live = false;
    };
  }, [repo]);
  return stars?.repo === repo ? stars.n : null;
}

const compact = (n: number) => (n < 1000 ? String(n) : `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`);

// GitHub's mark, from its own icon set.
const githubMark = (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
  </svg>
);

// The deployment solution the catalog serves.
const MODELSPHERE = "https://github.com/modelsphere/modelsphere";

// A repository on GitHub, with its stars; one elsewhere (a self-hosted
// catalog's), as a plain link.
function GitHubLink({ repo, title }: { repo: string; title: string }) {
  const stars = useStars(repo);
  return (
    <Button asChild className={topButton}>
      <a href={repo} target="_blank" rel="noopener" title={title}>
        {onGitHub(repo) ? githubMark : icons.external}
        <span className="max-[560px]:hidden">{repo.split("/").pop()}</span>
        {stars != null && (
          <span className="ml-[0.15rem] inline-flex items-center gap-1 border-l border-border pl-2 tabular-nums" title={`${stars} stars on GitHub`}>
            <StarIcon className="size-[0.95rem]!" aria-hidden="true" />
            {compact(stars)}
          </span>
        )}
      </a>
    </Button>
  );
}

// A page's header: the logo top left, linking home, and the GitHub links --
// modelsphere, then the catalog's source -- and the theme top right; then the
// breadcrumb, when the page is not the catalog itself; then its title
// centered, and what it is. children follow the description, centered too.
export function SiteHeader({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
}) {
  const { base, embedded } = useHost();
  // The catalog's own repository, as its index names it; the site's when the
  // index is not in.
  const repo = (useRouteLoaderData("root") as Catalog | undefined)?.repo ?? __REPO__;
  return (
    <header className="pt-5 pb-6 min-[1024px]:pb-8">
      <div className="wrap">
        {/* In another page, the page has its own. */}
        {!embedded && (
          <div className="mb-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-3 min-[1024px]:mb-8">
            {/* The mark's black ink turns white in dark mode, its blues kept. */}
            <Link to="/" className="shrink-0">
              <img src={`${base}logo.png`} alt="ModelSphere" className="h-6 w-auto min-[720px]:h-7 dark:invert dark:hue-rotate-180" />
            </Link>
            {/* The buttons wrap together, never one by one. */}
            <div className="ml-auto flex gap-2">
              <GitHubLink repo={MODELSPHERE} title="ModelSphere, the deployment solution, on GitHub" />
              <GitHubLink repo={repo} title="This catalog's source" />
              <ThemeButton />
            </div>
          </div>
        )}
        {eyebrow && (
          <p className="mb-4 text-[0.75rem] tracking-[0.08em] text-muted-foreground uppercase min-[1024px]:mb-6 [&_a]:text-inherit">{eyebrow}</p>
        )}
        <div className="text-center">
          <h1 className="font-display text-[clamp(2.5rem,7vw,3.75rem)] leading-[1.05] font-semibold tracking-[-0.02em] [&_em]:text-primary [&_em]:italic">
            {title}
          </h1>
          {description && <p className="mx-auto mt-4 max-w-[52rem] text-[1.05rem] text-balance text-foreground/80">{description}</p>}
          {children && <div className="mt-5 flex flex-col items-center gap-4">{children}</div>}
        </div>
      </div>
    </header>
  );
}

export function SiteFooter({ children }: { children: ReactNode }) {
  return (
    <footer className="wrap pt-10 pb-12 text-[0.84rem] text-faint">
      <p>{children}</p>
    </footer>
  );
}
