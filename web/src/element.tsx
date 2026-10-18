// <model-catalog>: the catalog as an element of another page -- the recipes,
// the models and each model's page, as the site has them, in a shadow root
// of its own, so neither page's styles reach the other's.
//
//   <script type="module" src="https://catalog.example.com/element/model-catalog.js"></script>
//   <model-catalog path="/models/kimi-k3" theme="dark"></model-catalog>
//
//   src    the catalog's root, where index-v2.json is: by default the one the
//          script was loaded from (it sits at <root>element/)
//   path   the page it opens: / (the recipes, ?hardware=B300 filtering them),
//          /models.html, /models/<name>; set later, it navigates there
//   theme  light, dark, or system (the default)
//   readonly
//          no editing, even where the catalog's server takes writes
//
// A navigation inside it fires "navigate", detail { path }, bubbling out of
// the shadow root, for a page that keeps the path in its own URL.
//
// npm run build:web builds it into dist/web/element/, beside the pages
// (vite.config.mts); build:site publishes it with them. Everything it needs is
// in the one file.
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { HostContext, type Host } from "@/lib/host";
import { catalogRoutes } from "@/routes";
import css from "./index.css?inline";
import fraunces from "@fontsource-variable/fraunces/opsz.css?inline";
import frauncesItalic from "@fontsource-variable/fraunces/opsz-italic.css?inline";

const THEMES = ["light", "dark"];

// What a shadow root cannot hold, the page gets once: @font-face rules only
// take effect in the document, and Tailwind's @property rules are what give
// its variables their initial values.
let documentStyled = false;
function styleDocument() {
  if (documentStyled) return;
  documentStyled = true;
  const style = document.createElement("style");
  style.dataset.modelCatalog = "";
  style.textContent = [fraunces, frauncesItalic, ...(css.match(/@property [^{]+\{[^}]*\}/g) ?? [])].join("\n");
  document.head.append(style);
}

class ModelCatalogElement extends HTMLElement {
  static observedAttributes = ["src", "path", "theme", "readonly"];

  #react: Root | null = null;
  #router: ReturnType<typeof createMemoryRouter> | null = null;
  #frame: HTMLDivElement | null = null;

  // The catalog's root, absolute and ending with /.
  get #base() {
    const src = this.getAttribute("src");
    const base = src ? new URL(src, document.baseURI) : new URL(/* @vite-ignore */ "../", import.meta.url);
    return base.href.replace(/\/*$/, "/");
  }

  connectedCallback() {
    styleDocument();
    this.#mount();
  }

  disconnectedCallback() {
    this.#unmount();
  }

  attributeChangedCallback(name: string, old: string | null, value: string | null) {
    if (!this.#react || old === value) return;
    if (name === "theme") this.#theme();
    else if (name === "path" && value != null) {
      const { pathname, search, hash } = this.#router!.state.location;
      if (value !== pathname + search + hash) this.#router!.navigate(value);
    } else if (name === "src" || name === "readonly") {
      this.#unmount();
      this.#mount();
    }
  }

  #theme() {
    const t = this.getAttribute("theme");
    if (t && THEMES.includes(t)) this.#frame!.dataset.theme = t;
    else delete this.#frame!.dataset.theme;
  }

  #mount() {
    const shadow = this.shadowRoot ?? this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `:host { display: block; }\n${css}`;
    // The frame is the site's <html>: tokens, theme and view are set on it.
    // Menus and dialogs open inside it, so they wear the same.
    const frame = document.createElement("div");
    frame.dataset.catalogRoot = "";
    const app = document.createElement("div");
    const portal = document.createElement("div");
    frame.append(app, portal);
    shadow.replaceChildren(style, frame);
    this.#frame = frame;
    this.#theme();

    const host: Host = { base: this.#base, embedded: true, root: frame, portal, readonly: this.hasAttribute("readonly") };
    // A link inside is a path of its own router, not of the page: opened in a
    // new tab or window, it is the catalog site's page at that path.
    const openOnSite = (e: MouseEvent) => {
      const a = (e.target as Element).closest?.("a[href^='/']");
      if (!a || (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey)) return;
      e.preventDefault();
      e.stopPropagation();
      window.open(new URL(a.getAttribute("href")!.slice(1), host.base), "_blank", "noopener");
    };
    frame.addEventListener("click", openOnSite, true);
    frame.addEventListener("auxclick", openOnSite, true);
    const router = createMemoryRouter(catalogRoutes(host.base), { initialEntries: [this.getAttribute("path") || "/"] });
    // The router reports every change of state; a navigation is one that
    // lands somewhere else.
    let at = router.state.location;
    router.subscribe(({ location }) => {
      if (location === at) return;
      at = location;
      const path = location.pathname + location.search + location.hash;
      this.dispatchEvent(new CustomEvent("navigate", { detail: { path }, bubbles: true, composed: true }));
    });
    this.#router = router;
    this.#react = createRoot(app);
    this.#react.render(
      <StrictMode>
        <HostContext.Provider value={host}>
          <RouterProvider router={router} />
        </HostContext.Provider>
      </StrictMode>,
    );
  }

  #unmount() {
    this.#react?.unmount();
    this.#router?.dispose();
    this.#react = this.#router = null;
  }
}

if (!customElements.get("model-catalog")) customElements.define("model-catalog", ModelCatalogElement);

declare global {
  interface HTMLElementTagNameMap {
    "model-catalog": ModelCatalogElement;
  }
}
