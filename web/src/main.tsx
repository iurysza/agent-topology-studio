// The shell: the bar (brand, nav, theme switch) and the routes: #/ workflows, #/w/:id the editor, #/roles, #/roles/:name, #/runs[?workflow=] and #/runs/:id.
// In all projects mode (GET /api/projects answers 200) those routes sit under #/p/<id>/, and #/ with no project is the project list.
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { Editor } from "./editor.tsx";
import { Home } from "./homepage.tsx";
import { RolePage, Roles } from "./roles.tsx";
import { RunPage, Runs } from "./runspage.tsx";
import { Projects, tilde } from "./projects.tsx";
import { api, listProjects, loadDir, mocked, projectRuns, readToken, setProject } from "./api.ts";
import { mergedRuns } from "./home.ts";
import { href, setRouteProject, splitHash, switchProject } from "./route.ts";
import { Select } from "./select.tsx";
import type { ProjectEntry } from "./types.ts";
import { isUnsaved, setUnsaved, unsavedWhat } from "./unsaved.ts";
import { Dialog } from "./dialog.tsx";
import { PLAIN_TITLE, showProjectTitle } from "./title.ts";

// The theme switch: System follows the OS, Light and Dark pin it. window.__theme is the init script's apply function.
const THEMES = [["system", "System"], ["light", "Light"], ["dark", "Dark"]] as const;
function ThemeSwitch() {
  const [t, setT] = useState(() => { const s = localStorage.getItem("theme"); return s === "light" || s === "dark" ? s : "system"; });
  const pick = (v: string) => { if (v === "system") localStorage.removeItem("theme"); else localStorage.setItem("theme", v); (window as unknown as { __theme?: () => void }).__theme?.(); setT(v); };
  return (
    <div className="seg" role="radiogroup" aria-label="Theme">
      {THEMES.map(([v, l]) => <button type="button" role="radio" aria-checked={t === v} key={v} className={t === v ? "on" : ""} onClick={() => pick(v)}>{l}</button>)}
    </div>
  );
}

type Route = { screen: "workflows" } | { screen: "editor"; id: string } | { screen: "roles" } | { screen: "role"; name: string }
  | { screen: "runs"; workflow?: string } | { screen: "run"; id: string; at?: string } | { screen: "projects" };
const parse = (h: string): Route => {
  const w = /^#\/w\/([^/?]+)/.exec(h); if (w) return { screen: "editor", id: decodeURIComponent(w[1]) };
  const r = /^#\/roles\/([^/?]+)/.exec(h); if (r) return { screen: "role", name: decodeURIComponent(r[1]) };
  const run = /^#\/runs\/([^/?]+)/.exec(h); if (run) return { screen: "run", id: decodeURIComponent(run[1]), at: new URLSearchParams(h.split("?")[1] ?? "").get("at") || undefined };
  if (/^#\/runs\/?(\?|$)/.test(h)) return { screen: "runs", workflow: new URLSearchParams(h.split("?")[1] ?? "").get("workflow") || undefined };
  return /^#\/roles\/?$/.test(h) ? { screen: "roles" } : { screen: "workflows" };
};
// The project is part of the key: a switch remounts <main>, so useDir and CopyPath fetch the new root.
const key = (r: Route, project: string | null) => (project ? `p:${project}|` : "") + (r.screen === "editor" ? `w:${r.id}` : r.screen === "role" ? `r:${r.name}` : r.screen === "run" ? `run:${r.id}` : r.screen);

/** The switcher's "All projects" value. Project ids never start with a space. */
const ALL = " all";

type Mode = "pending" | "single" | { projects: ProjectEntry[]; warnings: string[] };
/** Points the API client and href() at a project, or back at the single project. */
const scope = (p: string | null) => { setProject(p); setRouteProject(p); };

function App() {
  // The first hash's project applies before the first render, so no page fetches unscoped.
  const [{ project, r }, setNav] = useState(() => {
    const s = splitHash(location.hash);
    if (s.project) scope(s.project);
    return { project: s.project, r: parse(s.rest) };
  });
  const [mode, setMode] = useState<Mode>("pending");
  const modeRef = useRef<Mode>("pending");
  const projectRef = useRef(project);
  const [scrolled, setScrolled] = useState(false);
  const [leaving, setLeaving] = useState<{ to: string; what: string } | null>(null);
  // Leaving a page with unsaved edits asks first: the hash steps back at once (that step is not a route change)
  // and the dialog holds where the user was going. Discard clears the flag and goes there.
  useEffect(() => {
    readToken();
    let live = true;
    listProjects().then((list) => {
      if (!live) return;
      const m: Mode = list ?? "single";
      modeRef.current = m;
      if (!list && projectRef.current) {
        // A scoped hash against a single-project server: drop the scope and show the route under it.
        projectRef.current = null; scope(null);
        setNav((n) => ({ project: null, r: n.r }));
      }
      setMode(m);
      if (!list || projectRef.current) loadDir();
    });
    let undoing = false;
    const on = () => {
      if (undoing) { undoing = false; return; }
      if (isUnsaved()) { setLeaving({ to: location.hash, what: unsavedWhat() }); undoing = true; history.back(); return; }
      const s = splitHash(location.hash);
      const next = modeRef.current === "single" ? null : s.project;
      if (next !== projectRef.current) {
        projectRef.current = next; scope(next);
        if (next && modeRef.current !== "pending") loadDir();
      }
      setNav({ project: next, r: parse(s.rest) });
    };
    const close = (e: BeforeUnloadEvent) => { if (isUnsaved()) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("hashchange", on); window.addEventListener("beforeunload", close);
    return () => { live = false; window.removeEventListener("hashchange", on); window.removeEventListener("beforeunload", close); };
  }, []);
  const all = typeof mode === "object" ? mode : null;
  const listing = !!all && !project;
  // The project list lives at #/ alone: any unscoped hash in all projects mode shows it, and the address follows.
  // replaceState does not fire hashchange, so the leaving guard stays quiet.
  useEffect(() => { if (listing && location.hash !== "#/") history.replaceState(history.state, "", "#/"); }, [listing]);
  const shown: Route = listing ? { screen: "projects" } : r;
  const current = all && project ? all.projects.find((p) => p.id === project) : undefined;
  // The first option leads back to the list: on a phone the brand is hidden and this is the only way there.
  const projectOptions = useMemo(() => (all ? [{ value: ALL, label: "All projects", description: `${all.projects.length} with workflows` },
    ...all.projects.map((p) => ({ value: p.id, label: p.name, description: tilde(p.root) }))] : []), [all]);
  // The all projects home's Now band and row dots: the newest 10 projects' runs, merged (S10). Stable per project list.
  const allProjects = all?.projects;
  const loadAllRuns = useCallback(() => mergedRuns(allProjects ?? [], projectRuns), [allProjects]);
  // The browser tab names the project, not a path: "<name> · Topology studio". The project list keeps the plain name.
  useEffect(() => {
    if (mode === "pending" || listing) { document.title = PLAIN_TITLE; return; }
    return showProjectTitle(() => api.project());
  }, [mode, listing, project]);
  useEffect(() => { const on = () => setScrolled(scrollY > 4); on(); window.addEventListener("scroll", on, { passive: true }); return () => window.removeEventListener("scroll", on); }, []);
  return (
    <>
      <nav className={`bar${scrolled ? " scrolled" : ""}`} aria-label="Main">
        <div className="bar-l">
          <a className="brand" href="#/">Topology studio</a>
          {all && project ? <><span className="bar-slash" aria-hidden="true">/</span>
            <Select className="bar-proj" label={`Project: ${current?.name ?? project}. Switch project`} value={project} options={projectOptions} width={360}
              onChange={(id) => { location.hash = id === ALL ? "#/" : switchProject(location.hash, id); }} /></> : null}
        </div>
        {shown.screen === "projects" ? <div /> : <div className="switch">
          <a href={href("#/")} className={r.screen === "workflows" || r.screen === "editor" ? "on" : ""} aria-current={r.screen === "workflows" ? "page" : undefined}>Home</a>
          <a href={href("#/roles")} className={r.screen === "roles" || r.screen === "role" ? "on" : ""} aria-current={r.screen === "roles" ? "page" : undefined}>Roles</a>
          <a href={href("#/runs")} className={r.screen === "runs" || r.screen === "run" ? "on" : ""} aria-current={r.screen === "runs" ? "page" : undefined}>Runs</a>
        </div>}
        <div className="bar-r">{mocked ? <span className="quiet">Mock data</span> : null}<ThemeSwitch /></div>
      </nav>
      <Dialog open={!!leaving} onClose={() => setLeaving(null)} label="Unsaved changes" className="confirm" initialFocus=".keep">
        <h2 className="dlg-t">Unsaved changes</h2>
        <p className="dlg-p">{leaving?.what.replace(/^./, (c) => c.toUpperCase())} has changes that are not saved. Leave and lose them?</p>
        <div className="dlg-f">
          <button type="button" className="pill quiet keep" onClick={() => setLeaving(null)}>Keep editing</button>
          <button type="button" className="pill danger" onClick={() => { const to = leaving!.to; setLeaving(null); setUnsaved(false); location.hash = to; }}>Discard</button>
        </div>
      </Dialog>
      <main className={`screen s-${shown.screen === "editor" ? "editor" : "machines"}`} key={key(shown, project)}>
        {mode === "pending" ? <div className="loading" />
          : shown.screen === "projects" && all ? <Projects projects={all.projects} warnings={all.warnings} loadRuns={loadAllRuns} />
          : r.screen === "editor" ? <Editor id={r.id} back={{ label: "Home", href: href("#/") }} />
          : r.screen === "roles" ? <Roles />
          : r.screen === "role" ? <RolePage name={r.name} />
          : r.screen === "runs" ? <Runs workflow={r.workflow} />
          : r.screen === "run" ? <RunPage key={r.id} id={r.id} at={r.at} />
          : <Home seenScope={project ?? undefined} onOpen={(id) => { location.hash = href(`/w/${encodeURIComponent(id)}`); }} />}
      </main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
