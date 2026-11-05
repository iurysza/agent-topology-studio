// Runs: the journals Pi writes as it runs a workflow, read-only. #/runs lists them; #/runs/:id replays one on the graph.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { api, loadRun, loadRuns } from "./api.ts";
import { href } from "./route.ts";
import { MachineGraph } from "./graph.tsx";
import { Markdown } from "./markdown.tsx";
import { ChipValues } from "./chipinfo.tsx";
import { chipValue } from "./chipvalue.ts";
import { refsAt } from "./symbols.tsx";
import { playback, TICK_MS, type PlayAction } from "./playback.ts";
import { Select } from "./select.tsx";
import { RoleLink } from "./statecard.tsx";
import { PageHead, Sep, useListKeys, useNow } from "./parts.tsx";
import { ago, derive, duration, follow, mismatchMessage, paintAt, signalOf, span, type Run, type RunDetail, type Signal, type Step } from "./runs.ts";
import type { Machine, Role } from "./types.ts";

export const WORD: Record<Signal, string> = { success: "Succeeded", failed: "Failed", running: "Running", stopped: "Stopped", mismatch: "Mismatch" };
export const SignalDot = ({ s }: { s: Signal }) => <span className={`sig sig-${s}`} aria-hidden="true" />;
const runHref = (id: string) => href(`#/runs/${encodeURIComponent(id)}`);

export function Runs({ workflow }: { workflow?: string }) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [fixture, setFixture] = useState(false);
  const [ids, setIds] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const now = useNow(30_000);
  useEffect(() => { api.project().then((p) => setIds(p.workflows.map((w) => w.id))).catch(() => {}); }, []);
  useEffect(() => {
    let live = true;
    const load = () => loadRuns(workflow).then((r) => { if (live) { setRuns(r.runs); setFixture(r.fixture); setErr(null); } }).catch((e) => live && setErr((e as Error).message));
    load(); const t = setInterval(load, 5000);
    return () => { live = false; clearInterval(t); };
  }, [workflow]);
  const open = useCallback((i: number) => { const r = runs?.[i]; if (r) location.hash = runHref(r.id).slice(1); }, [runs]);
  const sel = useListKeys(runs?.length ?? 0, open);
  const pick = (w: string) => { location.hash = href(w ? `/runs?workflow=${encodeURIComponent(w)}` : "/runs"); };
  const choices = [...new Set([...ids, ...(workflow ? [workflow] : [])])].sort();

  const filter = (
    <label className="field filter"><span className="k label">Workflow</span>
      <Select value={workflow ?? ""} onChange={pick} label="Filter by workflow" width={220}
        options={[{ value: "", label: "All workflows" }, ...choices.map((w) => ({ value: w, label: w }))]} />
    </label>
  );
  const sub = runs ? <>{runs.length} {runs.length === 1 ? "run" : "runs"}<Sep />read from <code>.pi/workflows/*.workflow.jsonl</code>{fixture ? <><Sep /><span className="warn">dev fixture</span></> : null}</> : null;
  if (err) return <div className="page"><PageHead title="Runs" sub="Could not read the runs" actions={filter} /><p className="problem" role="alert">{err}</p></div>;
  if (!runs) return <div className="loading" />;
  return (
    <div className="page runs">
      <PageHead title="Runs" sub={sub} actions={filter} />
      {runs.length ? (
        <div className="rows" role="list">
          <div className="runrow runhead" aria-hidden="true"><span>Workflow</span><span>Outcome</span><span>Started</span><span className="num">Duration</span><span className="num">Steps</span></div>
          {runs.map((r, i) => { const s = signalOf(r, now); return (
            <div key={r.id} role="listitem" className={`row runrow${sel === i ? " sel" : ""}`} data-row={i}>
              <span className="rr-wf">
                <a className="row-link r-title" href={runHref(r.id)}><code>{r.workflow ?? "unmatched"}</code></a>
                <span className="rr-id">{r.id}</span>
              </span>
              {s === "running" ? <span className={`rr-sig s-${s}`}><SignalDot s={s} />{WORD[s]}</span>
                : s === "mismatch" ? <a className={`rr-sig rr-jump s-${s}`} href={runHref(r.id)} title={mismatchMessage(r) ?? undefined}><SignalDot s={s} />{WORD[s]}</a>
                : <a className={`rr-sig rr-jump s-${s}`} href={`${runHref(r.id)}?at=end`} title="Open the run where it ended"><SignalDot s={s} />{WORD[s]}</a>}
              <span className="rr-t" title={r.startedAt ?? undefined}>{ago(r.startedAt, now)}</span>
              <span className="rr-t num">{duration(span(r)) || "–"}</span>
              <span className="rr-t num">{r.calls}</span>
            </div>
          ); })}
        </div>
      ) : (
        <div className="empty"><p>No runs{workflow ? <> of <code>{workflow}</code></> : null} yet. Pi writes a journal to <code>.pi/workflows/</code> each time it runs a workflow.</p></div>
      )}
    </div>
  );
}

/** Everything recorded for one step: what the agent was asked, what it said, what the gate made of it. */
function StepFacts({ s, color, initOpen = false, machine, all }: { s: Step; color?: string | null; initOpen?: boolean; machine: Machine; all: Step[] }) {
  // what each reference held when this prompt went out: only steps made before it count
  const values = useMemo(() => { const before = all.filter((x) => x.n < s.n); return (p: string) => chipValue(p, before, s.state); }, [all, s.n, s.state]);
  const refs = useMemo(() => (machine.states[s.state] ? refsAt(machine, s.state) : []), [machine, s.state]);
  const [open, setOpen] = useState(initOpen), pid = useId();
  const fields = Object.entries(s.result ?? {}).filter(([k]) => k !== "text" && !(k === "event" && s.event));
  const timing = [s.at ? new Date(s.at).toLocaleTimeString() : null, duration(s.durationMs)].filter(Boolean).join(" · ");
  const prompt = s.template || s.prompt;
  return (
    <div className={`rstep${s.ok ? "" : " bad"}`}>
      <div className={`rs-top${prompt ? " can" : ""}${open ? " open" : ""}`}>
        <div className="sc-line rs-h">
          <span className="rs-n">#{s.n}</span>
          {s.branch ? <code className="sc-name">{s.branch}</code> : null}
          {s.role ? <RoleLink name={s.role} color={color} /> : <span className="dim">{s.kind}</span>}
          <span className={`rs-ok ${s.ok ? "ok" : "bad"}`}>{s.ok ? "ok" : "failed"}</span>
          {timing ? <span className="dim rs-time">{timing}</span> : null}
        </div>
        {prompt ? (
          <button type="button" className="rs-toggle" aria-expanded={open} aria-controls={pid} onClick={() => setOpen((o) => !o)}>
            <svg className="rs-chev" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2l3 3-3 3" /></svg>Prompt
          </button>
        ) : null}
      </div>
      {prompt ? (
        <div id={pid} className={`rs-fold${open ? " open" : ""}`} inert={!open}>
          <div><ChipValues.Provider value={values}><Markdown className="sc-prompt md" soft text={prompt} refs={refs} /></ChipValues.Provider></div>
        </div>
      ) : null}
      {fields.length ? <dl className="rs-fields">{fields.map(([k, v]) => <div key={k}><dt><code>{k}</code></dt><dd>{typeof v === "string" ? v : <code>{JSON.stringify(v)}</code>}</dd></div>)}</dl> : null}
      {s.text && !(s.result && typeof s.result === "object" && "event" in s.result) ? <pre className="rs-text">{s.text}</pre> : null}
      {s.event && s.to ? <div className="sc-line"><code className="sc-name">{s.event}</code><span className="sc-arrow" aria-hidden="true">→</span><code>{s.to}</code></div> : null}
      {s.gate ? <div className={`rs-gate ${s.gate.ok ? "ok" : "bad"}`}><span className="k label">Gate {s.gate.ok ? "passed" : "failed"}</span>{s.gate.output ? <pre>{s.gate.output}</pre> : null}</div> : null}
    </div>
  );
}

type VisitView = { n: number; steps: Step[]; entry?: Step };
const OUTCOME = { failure: "failed", success: "succeeded" } as const;

/** The card's Run section for one state: each visit the run has made by the scrubber, its retry number, and its steps so far.
 * `focus` opens the last visit's last prompt and scrolls it into view; a final state the run ended in names its outcome. */
function RunSection({ id, visits, machine, roles, focus, all }: { id: string; visits: VisitView[]; machine: Machine; roles: Role[]; focus: boolean; all: Step[] }) {
  const model = (r: string | null | undefined) => (r ? roles.find((x) => x.name === r)?.model : null);
  const st = machine.states[id], end = st?.kind === "final" && visits.length ? (st.outcome === "failure" ? "failure" : "success") : null;
  const lastRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (focus) requestAnimationFrame(() => lastRef.current?.scrollIntoView({ block: "nearest" })); }, [focus, id]);
  return (
    <section className={`sc-sect sc-run${end ? ` end-${end}` : ""}`}>
      <div className="sc-line"><span className="k label">Run</span>{end ? <span className="rv-end">Ended here · {OUTCOME[end]}</span> : null}</div>
      {!visits.length ? <p className="sc-desc">The run has not reached <code>{id}</code> at this step.</p> : visits.map((v, vi) => {
        const m = model(v.steps.find((s) => s.role)?.role ?? st?.role), lastV = vi === visits.length - 1;
        return (
          <div key={v.n} className="rvisit" ref={lastV ? lastRef : undefined}>
            <div className="sc-line"><span className="rv-n">Visit {v.n}</span>{v.n > 1 ? <span className="tag">retry {v.n - 1}</span> : null}{m ? <span className="dim">model <code>{m}</code></span> : null}</div>
            {v.steps.length ? v.steps.map((s, si) => <StepFacts key={s.n} s={s} machine={machine} all={all} initOpen={focus && lastV && si === v.steps.length - 1} color={s.role ? roles.find((x) => x.name === s.role)?.color : null} />)
              : st?.kind === "final" ? <div className="rv-arrive">
                {v.entry?.event ? <div className="sc-line"><code>{v.entry.state}</code><span className="dim">on</span><code className="sc-name">{v.entry.event}</code><span className="sc-arrow" aria-hidden="true">→</span><code className="rv-to">{id}</code></div> : null}
                <p className="sc-desc">The run ended here{end ? <>, <span className="rv-word">{OUTCOME[end]}</span></> : null}.</p>
              </div> : <p className="sc-desc">No result yet.</p>}
          </div>
        );
      })}
    </section>
  );
}

const Ico = ({ d, fill }: { d: string; fill?: boolean }) => <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" className={fill ? "fill" : undefined}><path d={d} /></svg>;
const ICON = {
  first: "M3.5 3v8M10.5 3.5 6 7l4.5 3.5Z", back: "M9.5 3.5 5 7l4.5 3.5Z", fwd: "M4.5 3.5 9 7l-4.5 3.5Z", last: "M10.5 3v8M3.5 3.5 8 7l-4.5 3.5Z",
  play: "M4.5 2.8v8.4c0 .4.4.6.7.4l6.4-4.2c.3-.2.3-.6 0-.8L5.2 2.4c-.3-.2-.7 0-.7.4Z", pause: "M4 3h2v8H4ZM8 3h2v8H8Z",
};
/** Step back, play or pause, step forward: one pill, the scrubber's quiet palette. The play icon carries the state. */
function Transport({ at, last, playing, act }: { at: number; last: number; playing: boolean; act: (a: PlayAction) => void }) {
  return (
    <div className="transport" role="group" aria-label="Playback">
      <button type="button" disabled={at === 0} onClick={() => act({ t: "seek", to: 0, last })} aria-label="First step" title="First step (Home)"><Ico d={ICON.first} fill /></button>
      <button type="button" disabled={at === 0} onClick={() => act({ t: "step", by: -1, last })} aria-label="Previous step" title="Previous step (←)"><Ico d={ICON.back} fill /></button>
      <button type="button" className={`tp-play${playing ? " on" : ""}`} disabled={last < 1} onClick={() => act({ t: "toggle", last })} aria-label={playing ? "Pause" : "Play"} aria-pressed={playing} title={playing ? "Pause (Space)" : "Play (Space)"}>
        <span className="tp-i a"><Ico d={ICON.play} fill /></span><span className="tp-i b"><Ico d={ICON.pause} fill /></span>
      </button>
      <button type="button" disabled={at === last} onClick={() => act({ t: "step", by: 1, last })} aria-label="Next step" title="Next step (→)"><Ico d={ICON.fwd} fill /></button>
      <button type="button" disabled={at === last} onClick={() => act({ t: "seek", to: last, last })} aria-label="Last step" title="Last step (End)"><Ico d={ICON.last} fill /></button>
    </div>
  );
}

type Load = { kind: "loading" } | { kind: "failed"; error: string } | { kind: "loaded"; run: RunDetail; fixture: boolean };

export function RunPage({ id, at: focusAt }: { id: string; at?: string }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [machine, setMachine] = useState<Machine | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [frame, setFrame] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [full, setFull] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null); // the state whose last visit is opened and scrolled to
  const now = useNow(1500);
  const frames = useRef(0);

  const run = load.kind === "loaded" ? load.run : null;
  const replay = useMemo(() => (run ? derive(run) : null), [run]);
  // New data moves the scrubber only when it sat on the newest frame.
  useEffect(() => { if (!replay) return; const prev = frames.current, next = replay.frames.length; frames.current = next; setFrame((f) => (f < 0 ? next - 1 : follow(f, prev, next))); }, [replay]);
  useEffect(() => { api.project().then((p) => setRoles(p.roles)).catch(() => {}); }, []);
  // Jump to where the run ended: the last step on the scrubber, full screen on the last walked state, its last visit open.
  const endState = replay?.visits[replay.visits.length - 1]?.state ?? null;
  const jump = useCallback((state: string | null) => {
    if (!replay || !state) return;
    setPlaying(false); setFrame(replay.frames.length - 1); setFocus(state); setOpen(state); setFull(true);
  }, [replay]);
  const jumped = useRef(false);
  useEffect(() => { if (focusAt && replay && machine && !jumped.current) { jumped.current = true; jump(focusAt === "end" ? endState : focusAt); } }, [focusAt, replay, machine, endState, jump]);
  useEffect(() => {
    let live = true, timer = 0;
    const tick = () => loadRun(id).then((r) => {
      if (!live) return;
      setLoad({ kind: "loaded", ...r });
      if (signalOf(r.run) === "running") timer = window.setTimeout(tick, 1500);
    }).catch((e) => live && setLoad((l) => (l.kind === "loaded" ? l : { kind: "failed", error: (e as Error).message })));
    tick();
    return () => { live = false; clearTimeout(timer); };
  }, [id]);
  const wf = run?.workflow;
  useEffect(() => { if (wf) api.workflow(wf).then((l) => setMachine(l.machine)).catch(() => setMachine(null)); }, [wf]);

  const last = (replay?.frames.length ?? 1) - 1, at = Math.max(0, Math.min(frame, last));
  const act = useCallback((a: PlayAction) => { const n = playback({ at, playing }, a); setFrame(n.at); setPlaying(n.playing); }, [at, playing]);
  // Playing walks one journal step per tick along the trail; it stops by itself on the last step.
  useEffect(() => { if (!playing) return; const t = window.setTimeout(() => act({ t: "tick", last }), TICK_MS); return () => clearTimeout(t); }, [playing, at, last, act]);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (full || e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).matches("input:not([type=range]),textarea,select,[role=combobox]")) return;
      if (e.key === " " && (e.target as HTMLElement).matches("button,a,summary")) return; // Space presses the focused control
      if (e.key === "ArrowLeft") act({ t: "step", by: -1, last });
      else if (e.key === "ArrowRight") act({ t: "step", by: 1, last });
      else if (e.key === "End") act({ t: "seek", to: last, last });
      else if (e.key === "Home") act({ t: "seek", to: 0, last });
      else if (e.key === " ") act({ t: "toggle", last });
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", on); return () => window.removeEventListener("keydown", on);
  }, [act, last, full]);

  const back = { label: "Runs", href: href(wf ? `#/runs?workflow=${encodeURIComponent(wf)}` : "#/runs") };
  if (load.kind === "failed") return <div className="page"><PageHead back={back} title={id} sub="Could not open this run" /><p className="problem" role="alert">{load.error}</p></div>;
  if (!run || !replay) return <div className="loading" />;
  const sig = signalOf(run, now), f = replay.frames[at], paint = paintAt(replay, at, machine);
  const upto = f?.step?.n ?? Infinity;
  const visitsOf = (state: string) => replay.visits.slice(0, (f?.visit ?? -1) + 1).filter((v) => v.state === state)
    .map((v): VisitView => { const i = replay.visits.indexOf(v); return { n: v.n, steps: v.steps.filter((s) => s.n <= upto), entry: i > 0 ? replay.visits[i - 1].steps.find((s) => s.to) : undefined }; });
  const cur = f ? replay.visits[f.visit] : null;
  const where = !f ? "No steps recorded" : f.step ? <>{f.step.branch ? <><code>{cur!.state}</code> · <code>{f.step.branch}</code></> : <code>{cur!.state}</code>}{f.step.event ? <> → <code>{f.step.event}</code></> : null}</>
    : <><code>{cur!.state}</code> · {machine?.states[cur!.state]?.kind === "final" ? "ended" : "waiting for a result"}</>;
  const mismatch = mismatchMessage(run);
  const sub = <><code>{run.workflow ?? "unmatched"}</code><Sep />{mismatch ? <span className={`rr-sig s-${sig}`}><SignalDot s={sig} />Journal mismatch</span> : sig !== "running" && endState && machine ? (
    <button type="button" className={`rr-sig rr-jump s-${sig}`} onClick={() => jump(endState)} title={`Show where the run ended: ${endState}`}><SignalDot s={sig} />{WORD[sig]}<span className="rr-at">at <code>{endState}</code></span></button>
  ) : <span className={`rr-sig s-${sig}`}><SignalDot s={sig} />{WORD[sig]}</span>}<Sep />{ago(run.startedAt, now)}<Sep />{duration(span(run)) || "–"}{run.reason ? <><Sep />{run.reason}</> : null}{load.kind === "loaded" && load.fixture ? <><Sep /><span className="warn">dev fixture</span></> : null}</>;
  const action = wf ? <a className="pill" href={href(`#/w/${encodeURIComponent(wf)}`)}>Open workflow</a> : null;

  return (
    <div className="page run-page">
      <PageHead back={back} title={<span className="run-title">{run.id}</span>} sub={sub} actions={action} />
      {mismatch ? <p className="problem" role="status">{mismatch}</p> : run.workflow === null ? (
        <p className="problem" role="status">This journal matches {run.candidates?.length ? <>{run.candidates.map((c, i) => <span key={c}>{i ? ", " : ""}<code>{c}</code></span>)}</> : "no workflow"}, so it cannot be replayed on a graph.</p>
      ) : (
        <section className="frame stage-run" data-tone={sig === "failed" ? "failed" : "running"}>
          {machine ? (
            <MachineGraph machine={machine} height={window.innerWidth < 768 ? 360 : Math.min(460, Math.round(window.innerHeight * 0.55))} full={full} setFull={(o) => { setFull(o); if (!o) { setOpen(null); setFocus(null); } }}
              view={{ run: paint, roleColor: (r) => roles.find((x) => x.name === r)?.color }}
              onSelect={(s) => { setOpen(s); setFull(true); }}
              run={{ open, section: (s) => <RunSection id={s} visits={visitsOf(s)} machine={machine} roles={roles} focus={s === focus} all={run.steps} /> }}
              readout={<div className="readout plain"><span className="rs">{machine.name}</span><span className="ra">step {at + 1} of {last + 1} · tap a state for what happened</span></div>} />
          ) : <div className="loading" style={{ height: 320 }} />}
          <div className="scrub">
            <div className="scrub-where" aria-live="polite">{where}</div>
            <input type="range" min={0} max={last} step={1} value={at} disabled={last < 1} aria-label="Step"
              aria-valuetext={`Step ${at + 1} of ${last + 1}`} onChange={(e) => act({ t: "seek", to: Number(e.target.value), last })} style={{ "--p": last ? `${(at / last) * 100}%` : "100%" } as CSSProperties} />
            <div className="scrub-n">
              <span className="num">{at + 1}<span className="dim"> / {last + 1}</span></span>
              <Transport at={at} last={last} playing={playing} act={act} />
              <button className={`pill sm ${at === last ? "quiet" : ""}`} disabled={at === last} onClick={() => act({ t: "seek", to: last, last })} title="Latest step (End)">{sig === "running" ? "Follow" : "Latest"}</button>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
