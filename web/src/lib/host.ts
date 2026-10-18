// Where the catalog is shown: its own site, or a <model-catalog> element in
// another page (element.tsx). Pages reach the catalog's files, the theme, and
// the page's URL, title and keys through this rather than the document, so
// the same routes serve both.
import { createContext, useContext, useEffect } from "react";

export type Host = {
  // The catalog's root, where index-v2.json and the files it names are;
  // ends with /.
  base: string;
  // In another page: the URL, the title and the scroll are the page's own.
  embedded: boolean;
  // What carries data-theme and data-view: <html> on the site.
  root: HTMLElement;
  // Where menus and dialogs open: the body on the site.
  portal?: HTMLElement;
  // No editing, even where the server takes writes: an element's readonly.
  readonly?: boolean;
};

export const HostContext = createContext<Host | null>(null);

let site: Host | null = null;
export function useHost(): Host {
  return useContext(HostContext) ?? (site ??= { base: import.meta.env.BASE_URL, embedded: false, root: document.documentElement });
}

// The tab's title, on the site only: an embedding page keeps its own.
export function useTitle(title: string) {
  const { embedded } = useHost();
  useEffect(() => {
    if (!embedded) document.title = title;
  }, [title, embedded]);
}
