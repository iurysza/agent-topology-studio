// The project list (all projects mode, #/ with no project): a launcher. Type a few letters, press Enter.
// Row links are built from the id, never through href(): href() would put them under the current project.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CopyPath, PageHead, Sep, useListKeys, useNow } from "./parts.tsx";
import { ago, LIVE_MS, signalOf, type Signal } from "./runs.ts";
import { link } from "./route.ts";
import { filterOptions } from "./select.tsx";
import { ALL_SCOPE, nowRows, quietLine, seenSnapshot, type ScopedRun } from "./home.ts";
import { NowBand } from "./homepage.tsx";
import { SignalDot, WORD as SIGNAL_WORD } from "./runspage.tsx";
import type { ProjectEntry } from "./types.ts";

/** Projects matching the query: name prefix, then name, then path (filterOptions' ranking). Server order within a rank. */
export function rankProjects(projects: ProjectEntry[], query: string): ProjectEntry[] {
  const byId = new Map(projects.map((p) => [p.id, p]));
  return filterOptions(projects.map((p) => ({ value: p.id, label: p.name, description: p.root })), query).map((o) => byId.get(o.value)!);
}

/** A home folder shown as ~, as people write it. The full path is still what gets copied. */
export const tilde = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");

/** The project's home, from its id alone: link() with an explicit id, not href(). */
const home = (p: ProjectEntry) => link("#/", p.id);
const open = (p: ProjectEntry) => { location.hash = link("#/", p.id); };

/** The newest run of each project in a list sorted newest first. */
const newestByProject = (runs: ScopedRun[]) => {
  const out = new Map<string, ScopedRun>();
  for (const r of runs) if (!out.has(r.project.id)) out.set(r.project.id, r);
  return out;
};

type Merged = { runs: ScopedRun[]; failed: string[] };
const newestFirst = (a: ScopedRun, b: ScopedRun) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt);

/** The next merged state. Every project failing is a failed load: keep the last list, or stay empty with none.
 * Some failing keeps each failed project's earlier runs, so one bad tick does not drop its alerts or dot. */
export function nextMerged(prev: Merged | null, next: Merged): Merged | null {
  if (!next.failed.length) return next;
  if (!prev) return next.runs.length ? next : null;
  const failed = new Set(next.failed);
  return { runs: [...next.runs, ...prev.runs.filter((r) => failed.has(r.project.id))].sort(newestFirst), failed: next.failed };
}

/** Merged runs across projects, refreshed like the home. A failed load keeps the last list; with none, there is no Now band and no dots. */
function useMergedRuns(load: (() => Promise<Merged>) | undefined) {
  const [state, setState] = useState<Merged | null>(null);
  useEffect(() => {
    if (!load) return;
    let live = true;
    const tick = () => load().then((r) => { if (live) setState((prev) => nextMerged(prev, r)); }).catch(() => {});
    tick(); const t = setInterval(tick, 5000);
    return () => { live = false; clearInterval(t); };
  }, [load]);
  return state;
}

/** `loadRuns` gives the merged runs for the Now band and each row's last signal (S11). Without it the list stands alone. */
export function Projects({ projects, warnings, loadRuns }: { projects: ProjectEntry[]; warnings: string[]; loadRuns?: () => Promise<Merged> }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const rows = useMemo(() => rankProjects(projects, q), [projects, q]);
  const go = useCallback((i: number) => { if (rows[i]) open(rows[i]); }, [rows]);
  const slash = useCallback((e: KeyboardEvent) => { if (e.key === "/") { e.preventDefault(); input.current?.focus(); input.current?.select(); } }, []);
  // While typing, the first match is what Enter opens, so it is drawn selected. One index for drawing and every Enter.
  const at = useListKeys(rows.length, go, slash, [sel < 0 && q.trim() ? 0 : sel, setSel]);
  const n = projects.length;
  const now = useNow(30_000);
  const merged = useMergedRuns(loadRuns);
  const runs = merged?.runs ?? null;
  const partial = !!merged?.failed.length;
  // H4: one snapshot per page load under the all projects key, read in render like the home.
  const seen = runs ? seenSnapshot(ALL_SCOPE) : null;
  const band = useMemo(() => runs && seen !== null ? nowRows(runs, seen, now) : null, [runs, seen, now]);
  const last = useMemo(() => runs ? newestByProject(runs) : null, [runs]);

  const head = (
    <PageHead title="Projects" sub={<>
      <span>{n} project{n === 1 ? "" : "s"} with workflows</span>
      {warnings.length ? <span className="proj-warn" title={warnings.join("\n")}>{warnings[0]}{warnings.length > 1 ? ` (and ${warnings.length - 1} more)` : ""}</span> : null}
    </>} />
  );

  if (!n) return (
    <div className="page">
      {head}
      <div className="empty welcome">
        <span className="e-t">No projects with .pi/workflows found</span>
        <span>Projects show up after Pi runs in them, or add a path to <code>~/.config/topology-studio/projects.json</code>:</span>
        <pre className="proj-sample"><code>{'{ "projects": ["~/dev/my-app"] }'}</code></pre>
      </div>
    </div>
  );

  return (
    <div className="page home projects">
      {head}
      {/* The quiet line claims a complete picture, so it waits while any project failed. */}
      {band && runs && (band.length || !partial) ? <NowBand rows={band} quiet={band.length ? "" : quietLine(runs, now)} now={now} showProject /> : null}
      <label className="field proj-search">
        <input ref={input} className="prose" type="search" value={q} spellCheck={false} autoComplete="off" autoFocus={n > 5}
          placeholder="Search projects" aria-label="Search projects" aria-controls="proj-rows"
          onChange={(e) => { setQ(e.target.value); setSel(-1); }}
          onKeyDown={(e) => {
            if (e.key === "/" && !q) e.preventDefault(); // already here: / means search, not a character
            else if (e.key === "Enter" && rows[at < 0 ? 0 : at]) { e.preventDefault(); open(rows[at < 0 ? 0 : at]); }
            else if (e.key === "Escape") { if (q) setQ(""); else input.current?.blur(); }
            else if (e.key === "ArrowDown") { e.preventDefault(); input.current?.blur(); if (rows.length) setSel(Math.max(at, 0)); }
          }} />
        {q ? null : <kbd aria-hidden="true">/</kbd>}
      </label>
      {rows.length ? (
        <div className="rows proj-rows" id="proj-rows">
          {rows.map((p, i) => {
            const live = !!p.lastRunAt && now - Date.parse(p.lastRunAt) < LIVE_MS;
            const r = last?.get(p.id);
            const signal: Signal | null = r ? signalOf(r, now) : null;
            const when = r ? ago(r.updatedAt, now) : null;
            return (
              <div key={p.id} className={`row plain${at === i ? " sel" : ""}`} data-row={i}>
                <span className="r-main">
                  <a className="r-title row-link" href={home(p)}>{p.name}</a>
                  <span className="r-sub"><CopyPath path={p.root} shown={tilde(p.root)} /></span>
                </span>
                <span className="r-side">
                  <span className="r-meta proj-meta">
                    {p.workflows} workflow{p.workflows === 1 ? "" : "s"}<Sep />
                    {p.lastRunAt ? signal
                      ? <span className={`proj-last s-${signal}`} role="img" aria-label={`Last run ${SIGNAL_WORD[signal].toLowerCase()} ${when}`}><SignalDot s={signal} /><span aria-hidden="true">{when}</span></span>
                      : <>{ago(p.lastRunAt, now)}{live ? <span className="proj-live" role="img" aria-label="Ran in the last 3 minutes" /> : null}</>
                      : "no runs yet"}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      ) : <div className="empty"><span className="e-t">No project matches “{q.trim()}”.</span></div>}
    </div>
  );
}
