// Project scope in the hash. In all projects mode every route sits under #/p/<id>/; in single mode the project is null
// and every helper returns its input unchanged.

const SCOPED = /^#?\/p\/[^/?#]+\//;

/** Splits "#/p/<id>/<rest>" into the project id and the unscoped hash. A hash with no id has no project. */
export function splitHash(h: string): { project: string | null; rest: string } {
  const m = /^#\/p\/([^/?#]+)(.*)$/.exec(h);
  if (!m) return { project: null, rest: h };
  const tail = m[2];
  return { project: m[1], rest: "#" + (tail.startsWith("/") ? tail : "/" + tail) };
}

/** Scopes a "#/..." or "/..." hash to `project`, in the same form it was given. Already scoped hashes come back unchanged. */
export function link(hash: string, project: string | null): string {
  if (project === null || SCOPED.test(hash)) return hash;
  if (hash.startsWith("#/")) return `#/p/${project}${hash.slice(1)}`;
  if (hash.startsWith("/")) return `/p/${project}${hash}`;
  return hash;
}

/** The hash after switching to project `id` from `hash`: the same tab under the new project, so #/p/a/runs goes to
 *  #/p/b/runs and a list's query stays. One workflow, role or run belongs to the old project, so its page lands on
 *  the new project's list for that tab. Built with link() and the new id, never href(). */
export function switchProject(hash: string, id: string): string {
  const { rest } = splitHash(hash);
  const to = /^#\/w\//.test(rest) ? "#/" : /^#\/(roles|runs)\/[^/?]/.test(rest) ? rest.replace(/^(#\/(?:roles|runs))\/.*$/, "$1")
    : rest.startsWith("#/") ? rest : "#/";
  return link(to, id);
}

let current: string | null = null;
/** The project every href() call scopes to. main.tsx sets it before the routes render. */
export const setRouteProject = (p: string | null) => { current = p; };
export const href = (h: string) => link(h, current);
