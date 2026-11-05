// Home: the project's name, then Now (what needs you), then its workflows, each with its shape, its last outcome and a strip of recent outcomes.
// Hand-written scripts are listed, quietly, as not editable; they have runs too, so they keep the side column.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, currentApi, loadRuns } from "./api.ts";
import { href, link } from "./route.ts";
import { Thumb } from "./graph.tsx";
import { CopyPath, PageHead, Sep, useListKeys, useNow } from "./parts.tsx";
import { SignalDot, WORD as SIGNAL_WORD } from "./runspage.tsx";
import { ago, duration, mismatchMessage, type Run, type Signal } from "./runs.ts";
import { installSeenFlush, ledgerByWorkflow, nowRows, quietLine, seenSnapshot, type NowRow, type ScopedRun, type WorkflowLedger } from "./home.ts";
import type { Project } from "./types.ts";

const basename = (dir: string) => dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;

// H4: the last-visit snapshot is written on pagehide and on hiding the tab, never on unmount.
installSeenFlush();

/** How many Now rows show before the rest fold into "N more". */
export const NOW_MAX = 5;
/** A run's page. A run from the merged all projects list carries its project, so it links under that project, whatever is current. */
const runLink = (run: Run) => {
  const p = (run as Partial<ScopedRun>).project;
  return p ? link(`#/runs/${encodeURIComponent(run.id)}`, p.id) : href(`#/runs/${encodeURIComponent(run.id)}`);
};
const MISMATCH_PREFIX = "Journal doesn't match this workflow: ";

/** The one line that says where a Now run is, or why it needs a look. */
function NowDetail({ row: { run, signal } }: { row: NowRow }) {
  const c = run.current;
  if (signal === "running") return c ? <>at <code>{c.state}</code>{c.visit > 1 ? `, visit ${c.visit}` : ""}</> : null;
  if (signal === "failed") return run.reason ? <>{run.reason}</> : run.at ? <>at <code>{run.at}</code></> : null;
  if (signal === "mismatch") { const m = mismatchMessage(run); return m ? <>{m.replace(MISMATCH_PREFIX, "")}</> : null; }
  if (signal === "stopped") return c ? <>stopped at <code>{c.state}</code></> : null;
  return null;
}

function NowRowView({ row, now, sel, index, showProject }: { row: NowRow; now: number; sel: boolean; index: number; showProject: boolean }) {
  const { run, signal } = row;
  const to = runLink(run);
  const title = run.title ?? run.workflow ?? "unmatched";
  const time = signal === "running" ? duration(run.startedAt ? now - Date.parse(run.startedAt) : null) : ago(run.updatedAt, now);
  const project = showProject ? (run as Partial<ScopedRun>).project?.name ?? "" : null;
  return (
    <div className={`row nrow${project !== null ? " with-proj" : ""}${sel ? " sel" : ""}`} data-row={index}>
      {project !== null ? <span className="n-proj" title={project}>{project}</span> : null}
      <span className={`rr-sig n-sig s-${signal}`}><SignalDot s={signal} />{SIGNAL_WORD[signal]}</span>
      <a className="r-title row-link n-title" href={to} aria-label={`${project ? `${project}: ` : ""}${title}, ${SIGNAL_WORD[signal].toLowerCase()}, ${time}. Open run ${run.id}.`}>{title}</a>
      <span className="n-detail"><NowDetail row={row} /></span>
      <span className="n-id">{run.id}</span>
      <span className="n-time" title={signal === "running" ? `Started ${run.startedAt ?? ""}` : run.updatedAt}>{time}</span>
      <span className="n-act">{signal === "running" ? <a className="n-watch" href={to}>Watch</a> : null}</span>
    </div>
  );
}

/** Now: running runs, then what failed, stopped or mismatched since the last visit. Nothing to show is one quiet line, no heading.
 * With showProject (all projects home) each row leads with its project's name, and "N more" is plain text: there is no all projects runs page. */
export function NowBand({ rows, quiet, now, sel = -1, showProject = false }: { rows: NowRow[]; quiet: string; now: number; sel?: number; showProject?: boolean }) {
  if (!rows.length) return <p className="h-quiet">{quiet}</p>;
  const more = rows.length - NOW_MAX;
  const key = (r: NowRow) => ((r.run as Partial<ScopedRun>).project?.id ?? "") + "/" + r.run.id;
  return (
    <section className="h-now" aria-labelledby="home-now">
      <h2 id="home-now" className="label h-head">Now</h2>
      <div className="rows">
        {rows.slice(0, NOW_MAX).map((r, i) => <NowRowView key={key(r)} row={r} now={now} sel={sel === i} index={i} showProject={showProject} />)}
      </div>
      {more > 0 ? showProject ? <span className="h-more">{more} more</span> : <a className="h-more" href={href("#/runs")}>{more} more</a> : null}
    </section>
  );
}

// Plain counts for the strip's label, in a fixed order so screen readers hear the same sentence shape every time.
const COUNTED: [Signal, string][] = [["success", "succeeded"], ["failed", "failed"], ["running", "running"], ["stopped", "stopped"], ["mismatch", "did not match"]];
const WORD = new Map(COUNTED);
const stripLabel = (recent: Signal[]) =>
  "Recent runs: " + COUNTED.map(([s, w]) => [recent.filter((x) => x === s).length, w] as const).filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}`).join(", ");

export function Ledger({ id, ledger, now }: { id: string; ledger: WorkflowLedger | undefined; now: number }) {
  const last = ledger?.last;
  if (!last) return <span className="h-never">never run</span>;
  const word = WORD.get(last.signal), when = ago(last.run.updatedAt, now);
  return (
    <span className="h-ledger">
      <a className={`h-last s-${last.signal}`} href={href(`#/runs/${encodeURIComponent(last.run.id)}`)}
        aria-label={`Last run of ${id} ${word} ${when}. Open run.`} title={`Last run ${word}, ${last.run.id}`}>
        <SignalDot s={last.signal} /><span className="h-ago">{when}</span>
      </a>
      <a className="h-strip" href={href(`#/runs?workflow=${encodeURIComponent(id)}`)} aria-label={stripLabel(ledger.recent)} title="Show this workflow's runs">
        {ledger.recent.map((s, i) => <span key={i} className={`s-${s}`}><SignalDot s={s} /></span>)}
      </a>
    </span>
  );
}

/** `seenScope` names the last-visit key. Single mode leaves it out and keys on the project folder; all mode passes the project id (H4). */
export function Home({ onOpen, seenScope }: { onOpen: (id: string) => void; seenScope?: string }) {
  const [p, setP] = useState<Project | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [asking, setAsking] = useState(false);
  const [id, setId] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const [c] = useState(currentApi);
  const now = useNow(30_000);
  useEffect(() => {
    c.project().then(async (proj) => {
      setP(proj);
      // The project list names workflows; their shapes come from each file, for the thumbs.
      const machines = await Promise.all(proj.workflows.map((w) => w.editable && !w.machine ? c.workflow(w.id).then((l) => l.machine).catch(() => undefined) : Promise.resolve(w.machine)));
      setP({ ...proj, workflows: proj.workflows.map((w, i) => ({ ...w, machine: machines[i] })) });
    }).catch((e) => setErr((e as Error).message));
  }, [c]);
  // Runs refresh like the Runs page. A failed load keeps the last list; with none, the side column stays empty rather than claim "never run".
  useEffect(() => {
    let live = true;
    const load = () => loadRuns().then((r) => { if (live) setRuns(r.runs); }).catch(() => {});
    load(); const t = setInterval(load, 5000);
    return () => { live = false; clearInterval(t); };
  }, []);
  const ledgers = useMemo(() => runs ? ledgerByWorkflow(runs, now) : null, [runs, now]);
  // H4: read once per page load, in render, never kept in state, so opening a run and coming back shows the same band.
  const seen = p ? seenSnapshot(seenScope ?? p.dir) : null;
  const now_ = useMemo(() => runs && seen !== null ? nowRows(runs, seen, now) : null, [runs, seen, now]);
  const shownNow = useMemo(() => now_?.slice(0, NOW_MAX) ?? [], [now_]);
  useEffect(() => { if (asking) input.current?.focus(); }, [asking]);
  const rows = p?.workflows ?? [];
  // One keyboard list: the Now rows first, then the workflows.
  const open = useCallback((i: number) => {
    const n = shownNow[i];
    if (n) { location.hash = href(`#/runs/${encodeURIComponent(n.run.id)}`).slice(1); return; }
    const w = rows[i - shownNow.length]; if (w?.editable) onOpen(w.id);
  }, [shownNow, rows, onOpen]);
  const extra = useCallback((e: KeyboardEvent) => { if (e.key === "n") { e.preventDefault(); setAsking(true); } }, []);
  const sel = useListKeys(shownNow.length + rows.length, open, extra);
  const wsel = sel - shownNow.length;

  const create = async () => {
    const v = id.trim();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(v)) { setProblem("Use lowercase letters, digits and hyphens."); return; }
    try { await c.create(v); onOpen(v); }
    catch (e) { setProblem(e instanceof ApiError && e.status === 409 ? `A workflow called ${v} already exists.` : (e as Error).message); }
  };

  if (err) return <div className="page"><PageHead title="Home" sub="Could not open the project" /><p className="problem" role="alert">{err}</p></div>;
  if (!p) return <div className="loading" />;
  return (
    <div className="page home">
      <PageHead title={p.name ?? basename(p.dir)}
        sub={<><CopyPath path={p.dir} />{p.branch ? <><Sep /><code title="Git branch">{p.branch}</code></> : null}</>}
        actions={<button className="pill primary" onClick={() => setAsking(true)}>New workflow</button>} />
      {asking ? (
        <form className="new-ask" onSubmit={(e) => { e.preventDefault(); create(); }}>
          <label className="field"><span className="k label">ID</span>
            <input ref={input} className="mono" value={id} spellCheck={false} placeholder="review-pr" aria-label="Workflow id"
              onChange={(e) => { setId(e.target.value); setProblem(null); }}
              onKeyDown={(e) => { if (e.key === "Escape") { setAsking(false); setId(""); setProblem(null); } }} />
            {problem ? <span className="hint err">{problem}</span> : <span className="hint">Becomes the file name: .pi/workflows/{id.trim() || "id"}.js</span>}
          </label>
          <button className="pill primary" type="submit">Create</button>
          <button className="pill quiet" type="button" onClick={() => { setAsking(false); setId(""); setProblem(null); }}>Cancel</button>
        </form>
      ) : null}
      {now_ && runs ? <NowBand rows={now_} quiet={now_.length ? "" : quietLine(runs, now)} now={now} sel={sel} /> : null}
      <section aria-labelledby="home-workflows">
        <h2 id="home-workflows" className="label h-head">Workflows</h2>
        <div className="rows">
          {rows.map((w, i) => {
            const title = <>{w.name ? <span className="h-name">{w.name}</span> : null}<code>{w.id}</code></>;
            return (
              <div key={w.id} className={`row mrow${wsel === i ? " sel" : ""}${w.editable ? "" : " locked"}`} data-row={shownNow.length + i}>
                <span className="r-thumb">{w.editable && w.machine ? <Thumb machine={w.machine} /> : <span className="tag">not editable</span>}</span>
                <span className="r-main">
                  {w.editable
                    ? <a className="r-title row-link" href={href(`#/w/${w.id}`)} onClick={(e) => { e.preventDefault(); onOpen(w.id); }}>{title}</a>
                    : <span className="r-title">{title}</span>}
                  <span className="r-sub"><span className="ell">{w.description || (w.editable ? "" : "A hand-written script. Edit it in your editor.")}</span></span>
                </span>
                <span className="r-side">{ledgers ? <Ledger id={w.id} ledger={ledgers.get(w.id)} now={now} /> : null}</span>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
