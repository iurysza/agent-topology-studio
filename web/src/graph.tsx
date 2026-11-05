// The state machine as a drawing: the layout, the list-row thumbnail, the inline graph with its drawing gestures,
// and the full-screen view with its own selection, zoom and pan.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import dagre, { type EdgeLabel, type GraphLabel, type NodeLabel } from "@dagrejs/dagre";
import type { Paint } from "./runs.ts";
import { StateCard } from "./statecard.tsx";
import type { Machine, State } from "./types.ts";

// ---------- colours and text ----------

export const PI_COLORS: string[] = ["blue", "cyan", "green", "magenta", "orange", "purple", "red", "yellow"];

/** The swatch classes for a Pi colour name; an unknown or empty colour gets the plain swatch. */
export const swatch = (color?: string | null): string => (color && PI_COLORS.includes(color) ? `sw c-${color}` : "sw");

/** `s` cut to `n` characters, the last one an ellipsis when it was longer. */
export const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`);

// ---------- layout ----------

export interface GNode { id: string; x: number; y: number; w: number; h: number; kind: string; title: string; role?: string; missing?: boolean; outcome?: string }

export interface GEdge { key: string; from: string; to: string; event: string; points: { x: number; y: number }[]; lx: number; ly: number; len: number }

export interface Layout { nodes: GNode[]; edges: GEdge[]; w: number; h: number; dir: "LR" | "TB" }

type Dir = "LR" | "TB";

type Point = { x: number; y: number };

/** A node's box before layout, in the shape dagre reads. */
type NodeSize = { width: number; height: number };

/** What a node shows under its id: the role for agent states, the outcome for final ones. */
type NodeFacts = { role?: string; outcome?: string };

/** Scale, offset and drawn size that fit a thumbnail layout into its box. */
export type ThumbBox = { sx: number; sy: number; ox: number; oy: number; sw: number; sh: number };

/** The class an edge path gets and the arrow marker it ends with. */
type EdgeStyle = { cls: string; marker: string };

const CHAR_W = 7.2;

const LABEL_CHARS = 18;

const TITLE_CHARS = 30;

const edgeKey = (from: string, event: string) => `${from}→${event}`;

const finite = (v: number | undefined, fallback: number) => (v !== undefined && Number.isFinite(v) ? v : fallback);

function nodeSize(id: string, title: string, role: string | undefined, detail: boolean): NodeSize {
  if (!detail) return { width: Math.max(84, Math.round(id.length * CHAR_W + 44)), height: 34 };

  const widest = Math.max(id.length * CHAR_W + 24, clip(title, TITLE_CHARS).length * 6.2, (role?.length ?? 0) * 6 + 22);

  return { width: Math.min(260, Math.max(150, Math.round(widest + 32))), height: 62 };
}

function polylineLength(points: Point[]): number {
  let total = 0;

  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);

  return total;
}

/** Facts a node shows that depend on the state's kind. */
function nodeFacts(s: State): NodeFacts {
  if (s.kind === "final") return { outcome: s.outcome ?? "success" };

  if ((s.kind === "task" || s.kind === "decision") && s.role) return { role: s.role };

  return {};
}

/** One node per state and per missing target, one edge per transition, laid out by dagre. */
export function layoutMachine(m: Machine, dir: Dir, detail = false): Layout {
  const g = new dagre.graphlib.Graph<GraphLabel, NodeLabel, EdgeLabel>({ multigraph: true });

  g.setGraph({ rankdir: dir, nodesep: detail ? 34 : 24, ranksep: detail ? 72 : 56, edgesep: 14, marginx: 16, marginy: 16 });
  g.setDefaultEdgeLabel(() => ({}));

  const missing = new Set<string>();

  for (const [id, s] of Object.entries(m.states)) g.setNode(id, nodeSize(id, s.title, nodeFacts(s).role, detail));

  for (const s of Object.values(m.states)) {
    for (const t of Object.values(s.on ?? {})) {
      if (Object.hasOwn(m.states, t.to) || missing.has(t.to)) continue;
      missing.add(t.to);
      g.setNode(t.to, nodeSize(`${t.to} ?`, "", undefined, detail));
    }
  }

  for (const [from, s] of Object.entries(m.states)) {
    for (const [event, t] of Object.entries(s.on ?? {})) {
      const shown = dir === "LR" ? clip(event, LABEL_CHARS) : event;

      g.setEdge(from, t.to, { width: shown.length * 6.2, height: 14, labelpos: "c" }, event);
    }
  }

  dagre.layout(g);

  const place = (id: string): Point & { w: number; h: number } => {
    const n = g.node(id);

    return { x: finite(n.x, 0), y: finite(n.y, 0), w: n.width, h: n.height };
  };

  const nodes: GNode[] = [];

  for (const [id, s] of Object.entries(m.states)) nodes.push({ id, ...place(id), kind: s.kind, title: s.title, ...nodeFacts(s) });

  for (const id of missing) nodes.push({ id, ...place(id), kind: "missing", title: "", missing: true });

  const edges: GEdge[] = [];

  for (const [from, s] of Object.entries(m.states)) {
    for (const [event, t] of Object.entries(s.on ?? {})) {
      const label = g.edge({ v: from, w: t.to, name: event });
      const a = place(from), b = place(t.to);
      const points = (label.points ?? [a, b]).map((p) => ({ x: finite(p.x, 0), y: finite(p.y, 0) }));
      const mid = points[Math.floor(points.length / 2)] ?? a;

      edges.push({ key: edgeKey(from, event), from, to: t.to, event, points, lx: finite(label.x, mid.x), ly: finite(label.y, mid.y), len: polylineLength(points) });
    }
  }

  const size = g.graph();

  return { nodes, edges, w: Math.max(1, finite(size.width, 1)), h: Math.max(1, finite(size.height, 1)), dir };
}

/** The direction that reads larger in a W by maxH box, and its scale, never above maxScale. Left to right wins ties. */
export function fit(m: Machine, W: number, maxH: number, maxScale: number, detail = false): { l: Layout; s: number } {
  const scaleOf = (l: Layout) => Math.max(0.01, Math.min(maxScale, W / l.w, maxH / l.h));
  const lr = layoutMachine(m, "LR", detail);
  const tb = layoutMachine(m, "TB", detail);
  const slr = scaleOf(lr), stb = scaleOf(tb);

  return slr >= stb * 0.9 ? { l: lr, s: slr } : { l: tb, s: stb };
}

const THUMB_MAX_SCALE = 0.4;

const usable = (v: number | undefined) => (v !== undefined && Number.isFinite(v) && v > 0 ? v : 1);

/** Maps a thumbnail layout size into a w by h box. Finite even for an empty machine, whose layout size is not. */
export function thumbBox(gw: number | undefined, gh: number | undefined, w: number, h: number): ThumbBox {
  const lw = usable(gw), lh = usable(gh);
  const s = Math.min(THUMB_MAX_SCALE, w / lw, h / lh);
  const sw = Math.max(1, Math.min(w, lw * s));

  return { sx: s, sy: s, ox: (sw - lw * s) / 2, oy: (h - lh * s) / 2, sw, sh: h };
}

// ---------- the thumbnail ----------

export function Thumb({ machine, w = 150, h = 52 }: { machine: Machine; w?: number; h?: number }) {
  const l = useMemo(() => layoutMachine(machine, "LR"), [machine]);
  const b = thumbBox(l.w, l.h, w, h);
  const px = (x: number) => b.ox + x * b.sx;
  const py = (y: number) => b.oy + y * b.sy;
  const at = new Map(l.nodes.map((n) => [n.id, n]));

  const links = l.edges.flatMap((e) => {
    const a = at.get(e.from), z = at.get(e.to);

    if (!a || !z || z.missing || e.from === e.to || z.x <= a.x) return [];

    const x1 = px(a.x + a.w / 2), y1 = py(a.y), x2 = px(z.x - z.w / 2), y2 = py(z.y), mx = (x1 + x2) / 2;

    return [<path key={e.key} d={`M${x1} ${y1}C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`} />];
  });

  const blocks = l.nodes.flatMap((n) => {
    if (n.missing) return [];

    const fin = n.kind === "final";

    return [<rect key={n.id} className={fin ? "fin" : undefined} x={px(n.x - n.w / 2)} y={py(n.y - n.h / 2)} width={n.w * b.sx} height={n.h * b.sy} rx={fin ? (n.h * b.sy) / 2 : 2} />];
  });

  return (
    <svg className="thumb" aria-hidden="true" width={b.sw} height={b.sh} viewBox={`0 0 ${b.sw} ${b.sh}`}>
      {links}
      {blocks}
    </svg>
  );
}

// ---------- what a drawing shows ----------

export interface View {
  selected?: string; edges?: Set<string>; targets?: Set<string>; problems?: Set<string>;
  roleColor?: (role: string) => string | null | undefined; run?: Paint;
}

export interface RunView { section: (id: string) => ReactNode; open?: string | null; onOpened?: () => void }

export interface Draw {
  onAdd: (from: string) => void;
  onConnect: (from: string, to: string, event: string) => void;
  onRetitle: (id: string, title: string) => void;
  eventName?: (from: string, to: string) => string;
  armed?: string | null; onArm?: (id: string) => void; onRemove?: (id: string) => void; onKeep?: () => void;
}

/** The drawing's hand controls, given only to the inline graph of an editor. */
interface Hands {
  draw: Draw;
  drop: string | null;
  onPlusDown: (from: string, e: ReactPointerEvent) => void;
  onRename: (id: string) => void;
}

interface Paper {
  l: Layout; machine: Machine; view: View; detail: boolean; uid: string;
  onPick?: (id: string) => void; hands?: Hands;
}

/** A smooth path through dagre's points. */
function curve(points: Point[]): string {
  if (points.length === 0) return "";

  let d = `M${points[0].x} ${points[0].y}`;

  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i], q = points[i + 1];

    d += `Q${p.x} ${p.y} ${(p.x + q.x) / 2} ${(p.y + q.y) / 2}`;
  }

  const last = points[points.length - 1];

  return points.length > 1 ? `${d}L${last.x} ${last.y}` : d;
}

const endOf = (m: Machine, id: string, run: Paint | undefined): string | null => {
  const s = m.states[id];

  if (!run || !s || s.kind !== "final" || !(run.visits.get(id) ?? 0)) return null;

  return `end-${s.outcome ?? "success"}`;
};

const titleOf = (m: Machine, id: string): string => {
  const s = m.states[id];

  if (!s) return "not written yet";

  return s.title || id;
};

function edgeClass(e: GEdge, paper: Paper): EdgeStyle {
  const run = paper.view.run;

  if (!run) {
    const walked = paper.view.edges?.has(e.key) ?? false;

    return { cls: walked ? "walked" : "idle", marker: walked ? "walked" : "idle" };
  }

  if (!run.trail.has(e.key)) return { cls: "untaken", marker: "idle" };

  const end = endOf(paper.machine, e.to, run);

  return end ? { cls: `trail ${end}`, marker: end } : { cls: "trail", marker: "walked" };
}

function EdgeMark({ e, paper }: { e: GEdge; paper: Paper }) {
  const { cls, marker } = edgeClass(e, paper);
  const hops = paper.view.run?.trail.get(e.key) ?? [];
  const shown = paper.l.dir === "LR" ? clip(e.event, LABEL_CHARS) : e.event;

  return (
    <g className={`e ${cls}`}>
      <path d={curve(e.points)} markerEnd={`url(#${paper.uid}-mk-${marker})`} />
      <text x={e.lx} y={e.ly} dy="0.32em" textAnchor="middle">
        {shown}
        <title>{`Transition ${e.event} → ${titleOf(paper.machine, e.to)}`}</title>
      </text>
      {hops.map((n, i) => (
        <g key={n} className="hop" transform={`translate(${e.lx + (i - (hops.length - 1) / 2) * 18} ${e.ly - 14})`}>
          <rect x={-7} y={-6} width={14} height={12} rx={6} />
          <text textAnchor="middle" dy="0.34em">{n}</text>
          <title>{`Step ${n}: ${e.from} → ${e.to}`}</title>
        </g>
      ))}
    </g>
  );
}

function nodeClass(n: GNode, paper: Paper): string {
  const { view, machine, hands } = paper;
  const run = view.run;
  const out = ["n", `k-${n.kind}`];

  if (n.missing) out.push("missing");
  else if (view.selected === n.id) out.push("lit");
  else if (view.targets?.has(n.id)) out.push("walked");
  else out.push("idle");

  if (view.selected === n.id) out.push("sel");

  if (view.problems?.has(n.id)) out.push("prob");

  if (run) {
    out.push(run.visits.get(n.id) ? "visited" : "unvisited");

    if (run.current === n.id) out.push("now");

    const end = endOf(machine, n.id, run);

    if (end) out.push(end);
  }

  if (hands?.drop === n.id) out.push("drop");

  if (hands?.draw.armed === n.id) out.push("armed");

  return out.join(" ");
}

function KindMark({ kind, x, y }: { kind: string; x: number; y: number }) {
  if (kind === "decision") return <path className="kg" d={`M${x} ${y - 4.5}L${x + 4.5} ${y}L${x} ${y + 4.5}L${x - 4.5} ${y}Z`} />;

  if (kind !== "fanout") return null;

  return (
    <g className="kg">
      <rect x={x - 4.5} y={y - 4.5} width={6} height={6} rx={1.2} />
      <rect x={x - 1.5} y={y - 1.5} width={6} height={6} rx={1.2} />
    </g>
  );
}

function Branches({ n, paper }: { n: GNode; paper: Paper }) {
  const results = paper.view.run?.branches.get(n.id) ?? [];

  if (!results.length) return null;

  const step = paper.detail ? 0 : 13;
  const start = n.w / 2 - ((results.length - 1) * step) / 2;

  return (
    <g className="brs">
      {results.map((b, i) => {
        const tone = b.ok === null ? "wait" : b.ok ? "ok" : "bad";
        const word = b.ok === null ? "no result yet" : b.ok ? "ok" : "failed";
        const x = paper.detail ? 12 + i * 40 : start + i * step;
        const y = paper.detail ? n.h + 6 : n.h + 4;

        return (
          <g key={b.id} className={`br ${tone}`} transform={`translate(${x} ${y})`}>
            <rect x={-4.5} y={0} width={9} height={9} rx={2} />
            {paper.detail ? <text x={8} y={8}>{b.id}</text> : null}
            <title>{`${b.id}: ${word}`}</title>
          </g>
        );
      })}
    </g>
  );
}

function NodeMark({ n, paper }: { n: GNode; paper: Paper }) {
  const { machine, view, detail, hands, uid, onPick } = paper;
  const run = view.run;
  const visits = run?.visits.get(n.id) ?? 0;
  const final = n.kind === "final";
  const lit = !n.missing && view.selected === n.id;
  const pickable = onPick !== undefined && !n.missing;
  const end = endOf(machine, n.id, run);
  const label = n.missing ? `${n.id} ?` : n.id;
  const hasMark = n.kind === "decision" || n.kind === "fanout";
  const rx = final ? n.h / 2 : 7;
  const pick = () => onPick?.(n.id);
  const plusAt = paper.l.dir === "LR" ? { x: n.w + 11, y: n.h / 2 } : { x: n.w / 2, y: n.h + 11 };
  const subtitle = end ? (end === "end-failure" ? "failed" : "succeeded") : clip(n.title, TITLE_CHARS);

  return (
    <g
      className={nodeClass(n, paper)}
      data-node={n.id}
      transform={`translate(${n.x - n.w / 2} ${n.y - n.h / 2})`}
      role={pickable ? "button" : undefined}
      tabIndex={pickable ? 0 : undefined}
      aria-label={pickable ? `${n.id}: ${n.title || n.id}` : undefined}
      onClick={pickable ? (e) => { e.stopPropagation(); pick(); } : undefined}
      onKeyDown={pickable ? (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        e.stopPropagation();
        pick();
      } : undefined}
      onDoubleClick={hands && !n.missing ? () => hands.onRename(n.id) : undefined}
    >
      <title>{n.missing ? "not written yet" : n.title}</title>
      <rect className="halo" x={-3} y={-3} width={n.w + 6} height={n.h + 6} rx={rx + 3} />
      <rect className="nb" width={n.w} height={n.h} rx={rx} fill={lit ? `url(#${uid}-lit)` : undefined} />
      {detail ? (
        <>
          <text className="nl" x={14} y={20}>{label}</text>
          {hasMark ? <KindMark kind={n.kind} x={n.w - 15} y={16} /> : null}
          {n.missing ? null : <text className="nt" x={14} y={38}>{subtitle}</text>}
          {n.role ? (
            <g className="rfoot">
              <circle className={`rsw ${swatch(view.roleColor?.(n.role))}`} cx={17} cy={n.h - 13} r={3.5}><title>{n.role}</title></circle>
              <text className="rl-t" x={26} y={n.h - 9.5}>{n.role}</text>
            </g>
          ) : null}
        </>
      ) : (
        <>
          {hasMark ? <KindMark kind={n.kind} x={14} y={n.h / 2} /> : null}
          <text className="nl" x={n.w / 2 + (hasMark ? 5 : 0) - (n.role ? 4 : 0)} y={n.h / 2} dy="0.34em" textAnchor="middle">{label}</text>
          {n.role ? <circle className={`rsw ${swatch(view.roleColor?.(n.role))}`} cx={n.w - 12} cy={n.h / 2} r={3.5}><title>{n.role}</title></circle> : null}
        </>
      )}
      {visits > 1 ? (
        <g className="vb" transform={`translate(${n.w - 2} ${-2})`}>
          <rect x={-11} y={-7} width={22} height={14} rx={7} />
          <text textAnchor="middle" dy="0.34em">{`×${visits}`}</text>
          <title>{`Visited ${visits} times`}</title>
        </g>
      ) : null}
      <Branches n={n} paper={paper} />
      {hands && !n.missing && !final ? (
        <g className="plus" role="button" aria-label={`Add a state after ${n.id}, or drag to connect`} transform={`translate(${plusAt.x} ${plusAt.y})`}
          onPointerDown={(e) => hands.onPlusDown(n.id, e)} onClick={(e) => e.stopPropagation()}>
          <circle r={8} />
          <path d="M-3.5 0H3.5M0 -3.5V3.5" />
        </g>
      ) : null}
      {hands?.draw.onArm && !n.missing ? (
        <g className="x" role="button" aria-label={`Remove ${n.id}`} transform={`translate(${n.w} 0)`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); hands.draw.onArm?.(n.id); }}>
          <circle r={7} />
          <path d="M-2.5 -2.5L2.5 2.5M2.5 -2.5L-2.5 2.5" />
        </g>
      ) : null}
    </g>
  );
}

const MARKERS = ["idle", "walked", "hl", "end-failure", "end-success"];

function Drawing({ paper, children }: { paper: Paper; children?: ReactNode }) {
  const { l, uid } = paper;

  return (
    <>
      <defs>
        {MARKERS.map((m) => (
          <marker key={m} id={`${uid}-mk-${m}`} className={`mk mk-${m}`} viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
            <path d="M0.5 1L9.5 5L0.5 9L3 5Z" />
          </marker>
        ))}
        <linearGradient id={`${uid}-lit`} x1="0" y1="0" x2="0" y2="1">
          <stop className="lit-a" offset="0" />
          <stop className="lit-b" offset="1" />
        </linearGradient>
      </defs>
      <g className="edges">{l.edges.map((e) => <EdgeMark key={e.key} e={e} paper={paper} />)}</g>
      <g className="nodes">{l.nodes.map((n) => <NodeMark key={n.id} n={n} paper={paper} />)}</g>
      {children}
    </>
  );
}

const markerId = (raw: string) => `g${raw.replace(/[^a-zA-Z0-9_-]/g, "")}`;

// ---------- inline dialogs ----------

function AskInline({ left, top, label, aria, value, mono, onDone }: {
  left: number; top: number; label: ReactNode; aria: string; value: string; mono?: boolean; onDone: (text: string | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  return (
    <div className="ask-inline" style={{ left, top }}>
      <span className="label">{label}</span>
      <input
        ref={input}
        className={mono ? "mono" : undefined}
        aria-label={aria}
        defaultValue={value}
        spellCheck={false}
        onBlur={() => onDone(null)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onDone(e.currentTarget.value.trim() || null);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onDone(null);
          }
        }}
      />
    </div>
  );
}

function ArmedConfirm({ id, left, top, onRemove, onKeep }: { id: string; left: number; top: number; onRemove: () => void; onKeep: () => void }) {
  const remove = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    remove.current?.focus();
  }, [id]);

  return (
    <div className="ask-inline confirm" role="alertdialog" aria-label={`Remove ${id}?`} style={{ left, top }}>
      <button ref={remove} type="button" className="pill sm danger" onClick={onRemove}>Remove <code>{id}</code></button>
      <button type="button" className="pill sm quiet" onClick={onKeep}>Keep it</button>
    </div>
  );
}

// ---------- the inline graph ----------

type Ask = { kind: "title"; id: string; value: string } | { kind: "event"; from: string; to: string; value: string };

type Drag = { from: string; x: number; y: number; over: string | null };

const PAD = 20;

const INLINE_MAX_SCALE = 1.15;

const MOVE_PX = 4;

const FullIcon = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 5.5V2h3.5M12 5.5V2H8.5M2 8.5V12h3.5M12 8.5V12H8.5" />
  </svg>
);

/** The state under a screen point, when it is an existing state other than `from`. */
function stateAt(m: Machine, from: string, x: number, y: number): string | null {
  const id = document.elementFromPoint(x, y)?.closest("[data-node]")?.getAttribute("data-node") ?? null;

  return id !== null && id !== from && Object.hasOwn(m.states, id) ? id : null;
}

export function MachineGraph({ machine, view, height, onSelect, readout, draw, full, setFull, run }: {
  machine: Machine; view: View; height: number; onSelect?: (s: string) => void; readout?: ReactNode; draw?: Draw;
  full: boolean; setFull: (open: boolean) => void; run?: RunView;
}) {
  const frameH = Math.max(240, height);
  const uid = markerId(useId());
  const frame = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const gesture = useRef<(() => void) | null>(null);
  const [width, setWidth] = useState(0);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);

  useLayoutEffect(() => {
    const el = frame.current;

    if (!el) return;

    setWidth(el.clientWidth);

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setWidth(entry.contentRect.width);
    });

    observer.observe(el);

    return () => observer.disconnect();
  }, []);

  useEffect(() => () => gesture.current?.(), []);

  const fitted = useMemo(() => (width > 0 ? fit(machine, width - PAD * 2, frameH - PAD * 2, INLINE_MAX_SCALE) : null), [machine, width, frameH]);
  const s = fitted?.s ?? 1;
  const ox = fitted ? (width - fitted.l.w * s) / 2 : 0;
  const oy = fitted ? (frameH - fitted.l.h * s) / 2 : 0;
  const nodeAt = (id: string) => fitted?.l.nodes.find((n) => n.id === id);
  const screen = (p: Point): Point => ({ x: ox + p.x * s, y: oy + p.y * s });

  const toPaper = (clientX: number, clientY: number): Point => {
    const r = svg.current?.getBoundingClientRect();

    return { x: (clientX - (r?.left ?? 0) - ox) / s, y: (clientY - (r?.top ?? 0) - oy) / s };
  };

  const startDrag = (from: string, e: ReactPointerEvent) => {
    if (!draw) return;
    e.stopPropagation();
    e.preventDefault();
    gesture.current?.();

    const start = { x: e.clientX, y: e.clientY };
    let moved = false;

    const onMove = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > MOVE_PX) moved = true;

      if (!moved) return;

      setDrag({ from, ...toPaper(ev.clientX, ev.clientY), over: stateAt(machine, from, ev.clientX, ev.clientY) });
    };

    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      gesture.current = null;
    };

    function onUp(ev: PointerEvent) {
      stop();
      setDrag(null);

      const to = moved ? stateAt(machine, from, ev.clientX, ev.clientY) : null;

      if (to === null || !draw) {
        draw?.onAdd(from);

        return;
      }

      setAsk({ kind: "event", from, to, value: draw.eventName?.(from, to) ?? to });
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    gesture.current = stop;
  };

  const hands: Hands | undefined = draw ? {
    draw,
    drop: drag?.over ?? null,
    onPlusDown: startDrag,
    onRename: (id) => setAsk({ kind: "title", id, value: machine.states[id]?.title ?? id }),
  } : undefined;

  const closeAsk = (text: string | null) => {
    const current = ask;

    setAsk(null);

    if (!current || text === null || !draw) return;

    if (current.kind === "title") draw.onRetitle(current.id, text);
    else draw.onConnect(current.from, current.to, text);
  };

  const dragFrom = drag ? nodeAt(drag.from) : undefined;
  const dragStart = dragFrom && fitted ? (fitted.l.dir === "LR" ? { x: dragFrom.x + dragFrom.w / 2 + 11, y: dragFrom.y } : { x: dragFrom.x, y: dragFrom.y + dragFrom.h / 2 + 11 }) : null;
  const armed = draw?.armed && Object.hasOwn(machine.states, draw.armed) ? nodeAt(draw.armed) : undefined;

  return (
    <>
      <div className="tools">
        <button type="button" className="pill sm ghost" title="Full screen (f)" onClick={() => setFull(true)}><FullIcon />Full screen</button>
      </div>
      <div ref={frame} className="gview" style={{ height: frameH }}>
        {fitted ? (
          <svg ref={svg} className={onSelect ? "graph edit pick" : "graph edit"} width={width} height={frameH}>
            <g transform={`translate(${ox} ${oy}) scale(${s})`}>
              <Drawing paper={{ l: fitted.l, machine, view, detail: false, uid, onPick: onSelect, hands }}>
                {drag && dragStart ? <path className="drag-line" d={`M${dragStart.x} ${dragStart.y}L${drag.x} ${drag.y}`} /> : null}
              </Drawing>
            </g>
          </svg>
        ) : null}
        {ask ? (() => {
          const a = nodeAt(ask.kind === "title" ? ask.id : ask.from);
          const b = ask.kind === "event" ? nodeAt(ask.to) : a;
          const at = a && b ? screen({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }) : { x: width / 2, y: frameH / 2 };

          const label = ask.kind === "title"
            ? <>Title of <code>{ask.id}</code></>
            : <>Transition from <code>{ask.from}</code> to <code>{ask.to}</code></>;

          return <AskInline left={at.x} top={at.y} label={label} aria={ask.kind === "title" ? "Title" : "Event name"} mono={ask.kind === "event"} value={ask.value} onDone={closeAsk} />;
        })() : null}
        {armed && draw ? (() => {
          const at = screen({ x: armed.x, y: armed.y + armed.h / 2 });

          return <ArmedConfirm id={armed.id} left={at.x} top={at.y + 8} onRemove={() => draw.onRemove?.(armed.id)} onKeep={() => draw.onKeep?.()} />;
        })() : null}
      </div>
      {full ? (
        <FullScreen machine={machine} view={view} readout={readout} run={run} onClose={() => setFull(false)}
          onSelect={run ? undefined : onSelect} />
      ) : null}
    </>
  );
}

// ---------- full screen ----------

type Camera = { x: number; y: number; k: number; ease: boolean };

const MIN_ZOOM = 0.15;

const MAX_ZOOM = 4;

const FIT_MAX = 1.5;

const KEY_STEP = 1.25;

const TOP_BAR = 64;

const BOTTOM_BAR = 48;

const SIDE = 40;

const CARD_W = 348;

const NARROW = "(max-width: 960px)";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function zoomAround(c: Camera, factor: number, ax: number, ay: number, ease: boolean): Camera {
  const k = clamp(c.k * factor, MIN_ZOOM, MAX_ZOOM);
  const r = k / c.k;

  return { x: ax - (ax - c.x) * r, y: ay - (ay - c.y) * r, k, ease };
}

const windowSize = () => ({ w: window.innerWidth, h: window.innerHeight });

const isField = (t: EventTarget | null) => t instanceof Element && t.matches("input, textarea, select");

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);

  useEffect(() => {
    const q = window.matchMedia(NARROW);
    const onChange = () => setNarrow(q.matches);

    q.addEventListener("change", onChange);

    return () => q.removeEventListener("change", onChange);
  }, []);

  return narrow;
}

function FullScreen({ machine, view, readout, run, onSelect, onClose }: {
  machine: Machine; view: View; readout?: ReactNode; run?: RunView; onSelect?: (s: string) => void; onClose: () => void;
}) {
  const uid = markerId(useId());
  const root = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const pan = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);
  const sheet = useNarrow();
  const [size, setSize] = useState(windowSize);
  const fitted = useMemo(() => fit(machine, size.w - SIDE * 2, size.h - TOP_BAR - BOTTOM_BAR, FIT_MAX, true), [machine, size]);
  const l = fitted.l;

  const fitCamera = (): Camera => ({
    x: (size.w - l.w * fitted.s) / 2,
    y: TOP_BAR + (size.h - TOP_BAR - BOTTOM_BAR - l.h * fitted.s) / 2,
    k: fitted.s,
    ease: true,
  });

  const centred = (id: string, c: Camera): Camera => {
    const n = l.nodes.find((x) => x.id === id);

    if (!n) return c;

    const clearW = sheet ? size.w : size.w - CARD_W;
    const clearH = sheet ? size.h * 0.36 : size.h;

    return { x: clearW / 2 - n.x * c.k, y: (sheet ? TOP_BAR : 0) + clearH / 2 - n.y * c.k, k: c.k, ease: true };
  };

  const opening = run?.open && Object.hasOwn(machine.states, run.open) ? run.open : null;
  const [sel, setSel] = useState<string | null>(opening);
  const [back, setBack] = useState<string[]>([]);
  const [camera, setCamera] = useState<Camera>(() => (opening ? centred(opening, fitCamera()) : fitCamera()));

  const select = (id: string) => {
    if (sel !== null && sel !== id) setBack([...back, sel]);
    setSel(id);
    setCamera((c) => centred(id, c));
  };

  const goBack = () => {
    const prev = back[back.length - 1];

    if (prev === undefined) return;

    setBack(back.slice(0, -1));
    setSel(prev);
    setCamera((c) => centred(prev, c));
  };

  const clear = () => {
    setSel(null);
    setBack([]);
  };

  const zoomKey = (factor: number) => setCamera((c) => zoomAround(c, factor, size.w / 2, size.h / 2, true));
  const refit = () => setCamera(fitCamera());

  // The key listener reads the newest state through this ref, so it is added once.
  const live = useRef({ sel, back, select, goBack, clear, onClose, zoomKey, refit, machine });

  useLayoutEffect(() => {
    live.current = { sel, back, select, goBack, clear, onClose, zoomKey, refit, machine };
  });

  useLayoutEffect(() => {
    const before = document.activeElement;

    close.current?.focus();
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = "";

      if (before instanceof HTMLElement && document.contains(before)) before.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isField(e.target)) return;

      const now = live.current;
      const first = now.sel === null ? undefined : Object.values(now.machine.states[now.sel]?.on ?? {})[0]?.to;
      let handled = true;

      if (e.key === "Escape") {
        if (now.sel !== null) now.clear();
        else now.onClose();
      } else if (e.key === "f") now.onClose();
      else if (e.key === "ArrowRight" && first !== undefined && Object.hasOwn(now.machine.states, first)) now.select(first);
      else if (e.key === "ArrowRight" && now.sel !== null) handled = true;
      else if (e.key === "ArrowLeft" && now.back.length > 0) now.goBack();
      else if (e.key === "+" || e.key === "=") now.zoomKey(KEY_STEP);
      else if (e.key === "-" || e.key === "_") now.zoomKey(1 / KEY_STEP);
      else if (e.key === "0") now.refit();
      else handled = false;

      if (!handled) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };

    const onResize = () => setSize(windowSize());

    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  // A resize refits the drawing to the new window.
  const firstSize = useRef(size);

  useEffect(() => {
    if (firstSize.current === size) return;
    firstSize.current = size;
    setCamera(fitCamera());
  }, [size]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = root.current;

    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      if (e.target instanceof Element && e.target.closest(".scard")) return;
      e.preventDefault();

      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * 0.002);

        setCamera((c) => zoomAround(c, factor, e.clientX, e.clientY, false));

        return;
      }

      setCamera((c) => ({ x: c.x - e.deltaX, y: c.y - e.deltaY, k: c.k, ease: false }));
    };

    el.addEventListener("wheel", onWheel, { passive: false });

    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.target instanceof Element && e.target.closest("[data-node]")) return;
    pan.current = { x: e.clientX, y: e.clientY, cx: camera.x, cy: camera.y, moved: false };

    if ("setPointerCapture" in e.currentTarget) e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const p = pan.current;

    if (!p) return;

    const dx = e.clientX - p.x, dy = e.clientY - p.y;

    if (Math.hypot(dx, dy) > MOVE_PX) p.moved = true;
    setCamera((c) => ({ x: p.cx + dx, y: p.cy + dy, k: c.k, ease: false }));
  };

  const onPointerUp = () => {
    const p = pan.current;

    pan.current = null;

    if (p && !p.moved) clear();
  };

  const ways = sel === null ? [] : Object.entries(machine.states[sel]?.on ?? {});

  const shown: View = {
    ...view,
    selected: sel ?? undefined,
    edges: new Set(ways.map(([event]) => edgeKey(sel ?? "", event))),
    targets: new Set(ways.map(([, t]) => t.to)),
  };

  const title = sel === null ? readout : (
    <div className="readout plain">
      <span className="rs">{machine.name}</span>
      <span className="ra"><code>{sel}</code> · {ways.length} {ways.length === 1 ? "way" : "ways"} out</span>
    </div>
  );

  const edit = onSelect && sel !== null ? () => {
    onSelect(sel);
    onClose();
  } : undefined;

  return createPortal(
    <div ref={root} className="full" data-tone="select" role="dialog" aria-modal="true" aria-label="Workflow, full screen">
      <svg className={sel === null ? "graph canvas edit pick" : "graph canvas edit pick has-sel"} width={size.w} height={size.h}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
        <g className={camera.ease ? "ease" : undefined} style={{ transform: `translate(${camera.x}px,${camera.y}px) scale(${camera.k})` }}>
          <Drawing paper={{ l, machine, view: shown, detail: true, uid, onPick: select }} />
        </g>
      </svg>
      <div className="full-top">
        <div className="full-title">{title}</div>
        <div className="full-tools">
          <div className="pills">
            <button type="button" aria-label="Zoom out" onClick={() => zoomKey(1 / KEY_STEP)}>−</button>
            <button type="button" className="pct" aria-label="Fit to screen" title="Fit (0)" onClick={refit}>{`${Math.round(camera.k * 100)}%`}</button>
            <button type="button" aria-label="Zoom in" onClick={() => zoomKey(KEY_STEP)}>+</button>
          </div>
          <button ref={close} type="button" className="pill sm ghost" onClick={onClose}>Close</button>
        </div>
      </div>
      <div className="full-bottom">
        <div className="legend">
          {run ? (
            <span><svg width="22" height="8" aria-hidden="true"><path className="lg out" d="M1 4H21" /></svg>the path this run took</span>
          ) : (
            <>
              <span><svg width="22" height="8" aria-hidden="true"><path className="lg out" d="M1 4H21" /></svg>ways out of the selected state</span>
              <span><svg width="22" height="8" aria-hidden="true"><path className="lg edit" d="M1 4H21" /></svg>a transition</span>
            </>
          )}
          <span className="dim">drag to pan · pinch or ⌘ scroll to zoom · 0 fits</span>
        </div>
      </div>
      {sel !== null ? (
        <StateCard machine={machine} id={sel} roleColor={view.roleColor} sheet={sheet} onWalk={select} onEdit={edit} onClose={clear}>
          {run ? run.section(sel) : null}
        </StateCard>
      ) : null}
    </div>,
    document.body,
  );
}
