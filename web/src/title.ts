// The browser tab names the project, not a path: "<name> · Topology studio".
export const PLAIN_TITLE = "Topology studio";

// Resets the tab to the plain name, then names the loaded project. A failed load keeps the plain name, so the
// tab never shows another project's name. The returned cancel drops a late answer after a project switch.
export function showProjectTitle(load: () => Promise<{ name?: string; dir: string }>): () => void {
  let live = true;
  document.title = PLAIN_TITLE;
  load().then((p) => {
    const name = p.name || p.dir.split(/[\\/]/).filter(Boolean).pop();
    if (live) document.title = name ? `${name} · ${PLAIN_TITLE}` : PLAIN_TITLE;
  }).catch(() => {});
  return () => { live = false; };
}
