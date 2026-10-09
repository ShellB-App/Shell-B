/**
 * Shell:B links: `shellb://<route>` names a place in the app, e.g. shellb://c/<chat>, shellb://codex/notes,
 * shellb://studio/<project>. The route is the app's own hash route without `#/`, so a link means the same thing in
 * every Shell:B (the owner's, a guest's): it opens there, and that instance's server decides what the person can see.
 *
 * Where they open:
 * - in a reply or message: Markdown.tsx turns them (and bare ones in text) into in-app links
 * - from other apps: the installed app registers `web+shellb:` (manifest protocol_handlers; browsers only let web
 *   apps claim `web+` schemes). The browser opens `/?link=<url>` in the app, and desktop.ts routes it. Bare
 *   `shellb://` is claimed by the small OS helper in clients/shellb-link, which hands it on as `web+shellb:`.
 */

const SCHEME = /^(?:web\+)?shellb:(?:\/\/)?/i;
// a route is a hash path: no spaces, quotes or angle brackets, so a link can't smuggle markup or leave the app
const ROUTE = /^[\w\-.~/%:@!$&'()*+,;=?]*$/;

/** The in-app route (`#/…`) a Shell:B link points to, or null if it isn't one. */
export function linkRoute(url: string): string | null {
  let route = url.trim();
  if (!SCHEME.test(route)) return null;
  // OS helpers pass a bare link on by prefixing it (web+shellb:shellb://c/x), so peel every scheme
  while (SCHEME.test(route)) route = route.replace(SCHEME, '');
  route = route.replace(/^\/+/, '').replace(/^#\/?/, '');
  return ROUTE.test(route) ? `#/${route}` : null;
}

/** The Shell:B link for an in-app route (`#/c/abc` → `shellb://c/abc`). */
export function shellbLink(route: string): string {
  return `shellb://${route.replace(/^#?\/*/, '')}`;
}

/** Bare shellb:// links in prose, for autolinking. Stops at whitespace and closing punctuation. */
export const BARE_LINK = /\b(?:web\+)?shellb:\/\/[\w\-.~/%:@!$&'*+,;=?]*[\w\-~/%@$&*+=]/gi;

interface MdNode { type: string; value?: string; url?: string; children?: MdNode[] }

/** remark plugin: bare shellb:// links in text become links (code spans and code blocks are separate nodes, so they
 *  are left alone). */
export function remarkShellbLinks() {
  const walk = (node: MdNode) => {
    if (!node.children || node.type === 'link' || node.type === 'linkReference') return;
    node.children = node.children.flatMap(child => {
      if (child.type !== 'text' || !child.value || !/shellb:\/\//i.test(child.value)) { walk(child); return [child]; }
      const out: MdNode[] = [];
      let last = 0;
      for (const m of child.value.matchAll(BARE_LINK)) {
        if (m.index > last) out.push({ type: 'text', value: child.value.slice(last, m.index) });
        out.push({ type: 'link', url: m[0], children: [{ type: 'text', value: m[0] }] });
        last = m.index + m[0].length;
      }
      if (last < child.value.length) out.push({ type: 'text', value: child.value.slice(last) });
      return out;
    });
  };
  return (tree: MdNode) => walk(tree);
}
