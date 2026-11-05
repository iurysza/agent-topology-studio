// The workflow editor: a draft of one machine, drawn on the stage and edited in the inspector. Nothing reaches disk
// until Save or ⌘S. One save runs at a time; a conflict on disk stops saving until the file is read again.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, currentApi } from "./api.ts";
import { idle, liveErrors, pruneBuffers, requestSave, finishSave, type Queue } from "./drafts.ts";
import { MachineGraph, swatch, type Draw, type View } from "./graph.tsx";
import { tokenize } from "./highlight.ts";
import * as ops from "./ops.ts";
import { CopyPath, PageHead, ProblemList, Sep, Block, useDir } from "./parts.tsx";
import { workflowPath } from "./paths.ts";
import { PromptDialog } from "./prompt-dialog.tsx";
import { href } from "./route.ts";
import { EventRows, FieldRows, TransitionHint, type EventDraft, type FieldDraft, type Keep } from "./rows.tsx";
import { Select, type Option } from "./select.tsx";
import { refsAt, SymbolField } from "./symbols.tsx";
import type { Kind, Loaded, Machine, Role, State } from "./types.ts";
import { setUnsaved } from "./unsaved.ts";
import { namedStates, validate } from "./validate.ts";

// ---------- small exported pieces ----------

const GLYPHS = new Map<string, ReactNode>([
  ["decision", <path d="M7 1.8L12.2 7L7 12.2L1.8 7Z" />],
  [
    "fanout",
    <>
      <rect x="1.5" y="1.5" width="7.5" height="7.5" rx="1.6" />
      <rect x="5" y="5" width="7.5" height="7.5" rx="1.6" />
    </>,
  ],
  ["final", <rect x="1.5" y="4" width="11" height="6" rx="3" />],
]);

export const KindGlyph = ({ kind }: { kind: string }) => (
  <svg className={`kglyph k-${kind}`} width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    {GLYPHS.get(kind) ?? <rect x="2" y="2" width="10" height="10" rx="2.5" />}
  </svg>
);

/** A callback ref and the element's border-box height, kept current while the element is attached. */
export function useMeasuredHeight<T extends HTMLElement>(): readonly [(el: T | null) => void, number] {
  const [el, setEl] = useState<T | null>(null);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setHeight(entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height);
    });

    observer.observe(el);

    return () => observer.disconnect();
  }, [el]);

  return [setEl, height] as const;
}

// ---------- editor state ----------

type Phase = { kind: "idle" } | { kind: "saving" } | { kind: "failed"; message: string } | { kind: "conflict"; message: string };

type Prompting = { at: string; branch: number | null };

const HINT_KEY = "topology:hint:draw";

const NARROW = "(max-width: 960px)";

const KINDS: Kind[] = ["task", "decision", "fanout", "final"];

const MAX_NOTES = 6;

const KIND_HINTS: Record<Kind, string> = {
  task: "One agent does the work, then picks a transition.",
  decision: "One agent reads the work so far and picks where to go.",
  fanout: "Several agents run side by side; the state moves on when all are done.",
  final: "The run ends here.",
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A rejection reason arrives untyped from the API promise; read it as text here, at that boundary. */
const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const same = (a: Machine, b: Machine) => JSON.stringify(ops.clean(a)) === JSON.stringify(ops.clean(b));

const isField = (t: EventTarget | null) => t instanceof Element && t.matches("input, textarea, select, [role=combobox]");

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function blockIds(m: Machine): string[] {
  return ["head", "inputs", ...Object.keys(m.states).map((id) => `state:${id}`)];
}

/** The state a block id names, or null for the workflow blocks. */
const stateBlock = (blk: string | null) => (blk?.startsWith("state:") ? blk.slice(6) : null);

/** The text of each transition buffer, so pruning can tell which buffers point at a state. */
function bufferText(rows: Record<string, EventDraft[]>): Record<string, string> {
  return Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.map((r) => `${r.name} → ${r.to}`).join("\n")]));
}

function freeBranchId(taken: string[]): string {
  for (let i = 0; ; i++) {
    const id = i < 26 ? String.fromCharCode(97 + i) : `b${i}`;

    if (!taken.includes(id)) return id;
  }
}

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

// ---------- form pieces ----------

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="k label">{label}</span>
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field">
      <span className="k label">{label}</span>
      {children}
    </div>
  );
}

function roleOptions(roles: Role[], current: string): Option[] {
  const out: Option[] = roles.map((r) => ({ value: r.name, label: r.name, description: r.description ?? undefined, swatch: swatch(r.color) }));

  if (current && !roles.some((r) => r.name === current)) out.push({ value: current, label: current, swatch: swatch() });

  return out;
}

/** A role picker; a known role also gets a link to its page. */
function RolePick({ label, value, roles, onChange }: { label: string; value: string; roles: Role[]; onChange: (v: string) => void }) {
  const known = roles.some((r) => r.name === value);

  return (
    <div className="field">
      <div className="field-h">
        <span className="k label">{label}</span>
        {known ? <a className="link" href={href(`#/roles/${encodeURIComponent(value)}`)}>Open role</a> : null}
      </div>
      <Select label={label} value={value} options={roleOptions(roles, value)} onChange={onChange} />
    </div>
  );
}

const kindOptions: Option[] = KINDS.map((k) => ({ value: k, label: k, glyph: <KindGlyph kind={k} /> }));

const outcomeOptions: Option[] = [{ value: "success", label: "success" }, { value: "failure", label: "failure" }];

// ---------- the editor ----------

export function Editor({ id, back }: { id: string; back: { label: string; href: string } }) {
  const [api] = useState(currentApi);
  const dir = useDir();
  const narrow = useNarrow();

  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Machine | null>(null);
  const [saved, setSaved] = useState<Machine | null>(null);
  const [code, setCode] = useState("");
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [generation, setGeneration] = useState(0);

  const [sel, setSel] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [fieldBufs, setFieldBufs] = useState<Record<string, FieldDraft[]>>({});
  const [eventBufs, setEventBufs] = useState<Record<string, EventDraft[]>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string[]>>({});

  const [tab, setTab] = useState<"graph" | "script">("graph");
  const [full, setFull] = useState(false);
  const [prompting, setPrompting] = useState<Prompting | null>(null);
  const [hint, setHint] = useState(() => localStorage.getItem(HINT_KEY) === null);
  const [measureRef, measured] = useMeasuredHeight<HTMLDivElement>();

  const hash = useRef("");
  const queue = useRef<Queue>(idle);
  const codeFor = useRef<Machine | null>(null);
  const focusTitle = useRef<string | null>(null);

  // ----- loading -----

  const apply = useCallback((l: Loaded) => {
    hash.current = l.hash;
    queue.current = idle;
    codeFor.current = l.machine;
    setLoadError(null);
    setDraft(l.machine);
    setSaved(ops.clean(l.machine));
    setCode(l.code);
    setFieldBufs({});
    setEventBufs({});
    setRowErrors({});
    setPhase({ kind: "idle" });
    setGeneration((g) => g + 1);
  }, []);

  useEffect(() => {
    let live = true;

    Promise.allSettled([api.workflow(id), api.project()]).then(([w, p]) => {
      if (!live) return;

      if (p.status === "fulfilled") setRoles(p.value.roles);

      if (w.status === "fulfilled") apply(w.value);
      else setLoadError(messageOf(w.reason));
    });

    return () => {
      live = false;
    };
  }, [api, id, apply]);

  const reload = () => {
    api.workflow(id).then(apply, (cause: unknown) => setLoadError(messageOf(cause)));
  };

  // ----- what the draft says -----

  const checked = useMemo(() => (draft ? validate(draft, roles ?? undefined) : { problems: [], warnings: [] }), [draft, roles]);
  const problems = useMemo(() => [...checked.problems, ...liveErrors(rowErrors, draft?.states ?? {})], [checked, rowErrors, draft]);
  const dirty = draft !== null && saved !== null && !same(draft, saved);
  const defaultRole = roles?.[0]?.name ?? "coder";

  // ----- the leave guard -----

  const guardName = draft ? draft.name || id : id;

  useEffect(() => {
    if (dirty) setUnsaved(true, `“${guardName}”`);
    else setUnsaved(false);
  }, [dirty, guardName]);

  useEffect(() => () => setUnsaved(false), []);

  // ----- saving -----

  const live = useRef({ draft, problems, phase, dirty });

  useLayoutEffect(() => {
    live.current = { draft, problems, phase, dirty };
  });

  const send = () => {
    const sent = live.current.draft;

    if (!sent) return;

    const body = ops.clean(sent);

    setPhase({ kind: "saving" });

    api.save(id, body, hash.current).then(
      (res) => {
        hash.current = res.hash;
        codeFor.current = sent;
        setSaved(body);
        setCode(res.code);

        const now = live.current;
        const due = queue.current.again && now.draft !== null && now.problems.length === 0 && !same(now.draft, body);
        const next = finishSave(queue.current, due);

        queue.current = next.q;

        if (next.start) send();
        else setPhase({ kind: "idle" });
      },
      (cause: unknown) => {
        queue.current = idle;

        const message = messageOf(cause);

        setPhase(cause instanceof ApiError && cause.status === 409 ? { kind: "conflict", message } : { kind: "failed", message });
      },
    );
  };

  const save = () => {
    const now = live.current;

    if (now.problems.length > 0 || now.phase.kind === "conflict" || !now.dirty) return;

    const asked = requestSave(queue.current);

    queue.current = asked.q;

    if (asked.start) send();
  };

  const discard = () => {
    setUnsaved(false);
    setPrompting(null);
    setSel(null);
    setArmed(null);
    setNotes([]);
    reload();
  };

  // ----- selection and edits -----

  const select = (blk: string | null) => {
    setSel(blk);
    setArmed(null);
  };

  const update = (next: Machine) => setDraft(next);

  const remove = (state: string) => {
    if (!draft) return;

    const r = ops.removeState(draft, state);
    const text = bufferText(eventBufs);

    setDraft(r.m);
    setNotes([...r.removed, ...notes].slice(0, MAX_NOTES));
    setEventBufs(pruneBuffers(eventBufs, state, text));
    setFieldBufs(pruneBuffers(fieldBufs, state, text));
    setRowErrors(pruneBuffers(rowErrors, state, text));
    select(null);
  };

  const rename = (from: string, to: string) => {
    if (!draft) return;

    const next = ops.renameState(draft, from, to);

    if (next === draft) return;

    const text = bufferText(eventBufs);

    setDraft(next);
    setEventBufs(pruneBuffers(eventBufs, from, text));
    setFieldBufs(pruneBuffers(fieldBufs, from, text));
    setRowErrors(pruneBuffers(rowErrors, from, text));

    if (sel === `state:${from}`) setSel(`state:${to}`);
  };

  const setState = (state: string, next: State) => {
    if (!draft) return;
    update({ ...draft, states: { ...draft.states, [state]: next } });
  };

  const opened = (added: { m: Machine; id: string }) => {
    setDraft(added.m);
    select(`state:${added.id}`);
    focusTitle.current = added.id;
  };

  const usedGraph = () => {
    localStorage.setItem(HINT_KEY, "1");
    setHint(false);
  };

  useEffect(() => {
    const want = focusTitle.current;

    if (want === null) return;

    const input = document.querySelector<HTMLInputElement>(`[data-title-for="${want}"]`);

    if (!input) return;

    focusTitle.current = null;
    input.focus();
    input.select();
  });

  useEffect(() => {
    if (sel === null) return;

    const el = document.querySelector(`.inspector [data-blk="${CSS.escape(sel)}"]`);

    el?.scrollIntoView?.({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
  }, [sel]);

  const keepRows = <D,>(bufs: Record<string, D[]>, set: (next: Record<string, D[]>) => void, key: string): Keep<D> => ({
    rows: bufs[key],
    set: (rows) => {
      const next = { ...bufs };

      if (rows === undefined) delete next[key];
      else next[key] = rows;
      set(next);
    },
  });

  const reportErrors = (key: string) => (errors: string[]) => {
    setRowErrors((prev) => {
      const before = prev[key] ?? [];

      if (before.length === errors.length && before.every((e, i) => e === errors[i])) return prev;

      return { ...prev, [key]: errors };
    });
  };

  // ----- the DSL pane recompiles after edits settle -----

  useEffect(() => {
    if (tab !== "script" || !draft || draft === codeFor.current) return;

    const timer = setTimeout(() => {
      codeFor.current = draft;
      api.compile(ops.clean(draft)).then((r) => setCode(r.code), () => {});
    }, 300);

    return () => clearTimeout(timer);
  }, [tab, draft, api]);

  // ----- keys -----

  const onKey = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save();

      return;
    }

    if (isField(e.target)) {
      if (e.key === "Escape" && e.target instanceof HTMLElement) e.target.blur();

      return;
    }

    if (e.metaKey || e.ctrlKey || e.altKey || full || prompting || !draft) return;

    const ids = blockIds(draft);
    const at = sel === null ? -1 : ids.indexOf(sel);
    const selected = stateBlock(sel);

    if (e.key === "j" || e.key === "ArrowDown") {
      e.preventDefault();
      select(ids[at < 0 ? 0 : Math.min(ids.length - 1, at + 1)] ?? null);
    } else if (e.key === "k" || e.key === "ArrowUp") {
      e.preventDefault();
      select(ids[at < 0 ? 0 : Math.max(0, at - 1)] ?? null);
    } else if (e.key === "f" && tab === "graph") {
      setFull(true);
    } else if (armed !== null && (e.key === "Delete" || e.key === "Backspace" || e.key === "Enter")) {
      e.preventDefault();
      remove(armed);
    } else if (armed !== null && e.key === "Escape") {
      setArmed(null);
    } else if ((e.key === "Delete" || e.key === "Backspace") && selected !== null && Object.hasOwn(draft.states, selected)) {
      e.preventDefault();
      setArmed(selected);
    } else if (e.key === "Escape" && sel !== null) {
      select(null);
    } else if (e.key === "Escape") {
      location.hash = back.href.slice(1);
    }
  };

  const keyHandler = useRef(onKey);

  useLayoutEffect(() => {
    keyHandler.current = onKey;
  });

  useEffect(() => {
    const listener = (e: KeyboardEvent) => keyHandler.current(e);

    window.addEventListener("keydown", listener);

    return () => window.removeEventListener("keydown", listener);
  }, []);

  // ----- render -----

  if (loadError !== null) {
    return (
      <div className="page editor">
        <PageHead back={back} title={id} sub="Could not open this workflow" />
        <p className="problem" role="alert">{loadError}</p>
      </div>
    );
  }

  if (!draft) return <div className="loading" />;

  const m = draft;
  const count = Object.keys(m.states).length;
  const selected = stateBlock(sel);
  const ways = selected !== null ? Object.entries(m.states[selected]?.on ?? {}) : [];
  const conflict = phase.kind === "conflict";
  const saving = phase.kind === "saving";

  const statusWord = problems.length > 0 ? plural(problems.length, "problem")
    : conflict ? "changed on disk"
      : phase.kind === "failed" ? "not saved"
        : saving ? "saving…"
          : dirty ? "unsaved"
            : "saved";

  const warn = problems.length > 0 || conflict || phase.kind === "failed";

  const okText = phase.kind === "failed" ? `Could not save: ${phase.message}` : conflict ? phase.message : "Nothing to fix. ⌘S saves.";

  const view: View = {
    selected: selected ?? undefined,
    edges: new Set(ways.map(([event]) => `${selected}→${event}`)),
    targets: new Set(ways.map(([, t]) => t.to)),
    problems: new Set(problems.flatMap(namedStates)),
    roleColor: (role) => roles?.find((r) => r.name === role)?.color,
  };

  const draw: Draw = {
    onAdd: (from) => {
      usedGraph();
      opened(ops.addAfter(m, from, defaultRole));
    },
    onConnect: (from, to, event) => {
      usedGraph();
      update(ops.connect(m, from, to, event));
      select(`state:${from}`);
    },
    onRetitle: (state, title) => update(ops.retitle(m, state, title)),
    eventName: (from, to) => ops.eventNameFor(m, from, to),
    armed,
    onArm: (state) => {
      select(`state:${state}`);
      setArmed(state);
    },
    onRemove: remove,
    onKeep: () => setArmed(null),
  };

  const stageHeight = narrow ? Math.round(window.innerHeight * 0.55) : Math.max(240, measured - 44 - 38);

  const actions = (
    <>
      <a className="pill quiet" href={href(`#/runs?workflow=${id}`)} title={`Runs of ${id}`}>Runs</a>
      {conflict ? (
        <button type="button" className="pill" onClick={reload}>Reload</button>
      ) : (
        <>
          {dirty && !saving ? <button type="button" className="pill quiet" title="Drop unsaved changes and reload the file" onClick={discard}>Discard</button> : null}
          <button type="button" className={dirty && problems.length === 0 ? "pill primary" : "pill"} title="Save now (⌘S)"
            disabled={problems.length > 0 || !dirty || saving} onClick={save}>Save</button>
        </>
      )}
    </>
  );

  const sub = (
    <>
      <code>{id}</code>
      <Sep />
      {plural(count, "state")}
      {dir ? <><Sep /><CopyPath path={workflowPath(dir, id)} /></> : null}
      <Sep />
      <span className={warn ? "warn" : undefined}>{statusWord}</span>
    </>
  );

  const pick = (p: string) => {
    const hit = namedStates(p).find((s) => Object.hasOwn(m.states, s));

    if (hit !== undefined) select(`state:${hit}`);
  };

  const summary = (blk: string, open: boolean, content: ReactNode, body: () => ReactNode) => (
    <div key={`${blk}#${generation}`} className={open ? "blk sel" : "blk"} data-blk={blk}>
      <button type="button" className="sum" aria-expanded={open} onClick={() => { if (!open) select(blk); }}>{content}</button>
      {open ? <div className="body">{body()}</div> : null}
    </div>
  );

  const stateOptions: Option[] = Object.entries(m.states).map(([sid, s]) => ({ value: sid, label: sid, description: s.title, glyph: <KindGlyph kind={s.kind} /> }));

  const headBody = () => (
    <>
      <Field label="Name"><input value={m.name} onChange={(e) => update({ ...m, name: e.target.value })} /></Field>
      <Field label="Description" hint="What the workflow does, for people and for agents choosing one.">
        <textarea rows={3} value={m.description} onChange={(e) => update({ ...m, description: e.target.value })} />
      </Field>
      <Field label="When to use"><textarea rows={2} value={m.whenToUse ?? ""} onChange={(e) => update({ ...m, whenToUse: e.target.value })} /></Field>
      <Field label="ID"><input className="mono" value={id} readOnly /></Field>
      <Group label="Initial state">
        <Select label="Initial state" mono value={m.initial} options={stateOptions} onChange={(v) => update({ ...m, initial: v })} />
      </Group>
    </>
  );

  const inputsBody = () => (
    <FieldRows label="Inputs" value={m.inputs} withDefault onChange={(v) => update({ ...m, inputs: v })}
      onErrors={reportErrors("inputs")} keep={keepRows(fieldBufs, setFieldBufs, "inputs")} />
  );

  const promptField = (sid: string, value: string, onChange: (v: string) => void, branch: number | null, label = "Prompt") => (
    <SymbolField label={label} value={value} machine={m} at={sid} onChange={onChange} uid={branch === null ? sid : `${sid}-${branch}`}
      onExpand={() => setPrompting({ at: sid, branch })} />
  );

  const stateBody = (sid: string, s: State) => {
    const setBranches = (branches: State["branches"]) => setState(sid, { ...s, branches });

    return (
      <>
        <Field label="ID">
          <input key={sid} className="mono" defaultValue={sid} spellCheck={false}
            onBlur={(e) => rename(sid, e.target.value.trim())}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
        </Field>
        <Group label="Kind">
          <Select label="Kind" value={s.kind} options={kindOptions} onChange={(v) => {
            const kind = KINDS.find((k) => k === v);

            if (kind) setState(sid, ops.setKind(s, kind, defaultRole));
          }} />
          <span className="hint">{KIND_HINTS[s.kind]}</span>
        </Group>
        <Field label="Title">
          <input data-title-for={sid} value={s.title} onChange={(e) => update(ops.setField(m, sid, "title", e.target.value))} />
        </Field>
        {s.kind === "task" || s.kind === "decision" ? (
          <>
            <RolePick label="Role" value={s.role ?? ""} roles={roles ?? []} onChange={(v) => update(ops.setField(m, sid, "role", v))} />
            {promptField(sid, s.prompt ?? "", (v) => update(ops.setField(m, sid, "prompt", v)), null)}
            <FieldRows label="Output" value={s.output} onChange={(v) => setState(sid, { ...s, output: v })}
              onErrors={reportErrors(`out:${sid}`)} keep={keepRows(fieldBufs, setFieldBufs, `out:${sid}`)} />
          </>
        ) : null}
        {s.kind === "fanout" ? (
          <Group label="Branches">
            {(s.branches ?? []).map((b, i) => {
              const list = s.branches ?? [];
              const edit = (patch: Partial<typeof b>) => setBranches(list.map((x, j) => (j === i ? { ...x, ...patch } : x)));

              return (
                <div key={i} className="branch">
                  <div className="branch-h">
                    <span className="label">Branch {i + 1}</span>
                    {list.length > 2 ? <button type="button" className="link" onClick={() => setBranches(list.filter((_, j) => j !== i))}>Remove</button> : null}
                  </div>
                  <Field label="ID">
                    <input className="mono" value={b.id} spellCheck={false} onChange={(e) => edit({ id: e.target.value })} />
                  </Field>
                  <RolePick label="Role" value={b.role} roles={roles ?? []} onChange={(v) => edit({ role: v })} />
                  {promptField(sid, b.prompt, (v) => edit({ prompt: v }), i)}
                </div>
              );
            })}
            <div className="blk-foot">
              <button type="button" className="link" onClick={() => {
                const list = s.branches ?? [];

                setBranches([...list, { id: freeBranchId(list.map((b) => b.id)), role: defaultRole, prompt: "" }]);
              }}>+ Add branch</button>
            </div>
          </Group>
        ) : null}
        {s.kind !== "final" ? (
          <EventRows from={sid} value={s.on} states={m.states} max={s.kind === "fanout" ? 1 : undefined} hint={<TransitionHint kind={s.kind} />}
            onChange={(v) => setState(sid, { ...s, on: v })} onErrors={reportErrors(`on:${sid}`)} keep={keepRows(eventBufs, setEventBufs, `on:${sid}`)} />
        ) : (
          <Group label="Outcome">
            <Select label="Outcome" value={s.outcome ?? "success"} options={outcomeOptions} onChange={(v) => update(ops.setField(m, sid, "outcome", v))} />
          </Group>
        )}
        {s.kind !== "final" ? (
          <Field label="Max visits" hint="Leave empty for no limit.">
            <input type="number" min={1} value={s.maxVisits ?? ""} onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10);

              update(ops.setField(m, sid, "maxVisits", Number.isFinite(n) && n > 0 ? n : undefined));
            }} />
          </Field>
        ) : null}
        <div className="blk-foot">
          <button type="button" className="link" onClick={() => remove(sid)}>Remove this state</button>
        </div>
      </>
    );
  };

  const inputNames = Object.keys(m.inputs ?? {});

  const inspector = (
    <aside className="inspector">
      <div className="insp-scroll">
        {summary("head", sel === "head", <><span className="s-k">Workflow</span><span className="s-t">{m.name}</span></>, headBody)}
        {summary("inputs", sel === "inputs", <><span className="s-k">Inputs</span><span className="s-t">{inputNames.length ? inputNames.join(", ") : "None"}</span></>, inputsBody)}
        <div className="insp-h">
          <span className="label">States</span>
          <span className="quiet">{count}<Sep />starts at <code>{m.initial}</code></span>
        </div>
        {Object.entries(m.states).map(([sid, s]) => {
          const named = (list: string[]) => list.some((p) => namedStates(p).includes(sid));
          const mark = named(problems) ? <Block tone="waiting" /> : named(checked.warnings) ? <Block /> : null;

          const content = (
            <>
              <KindGlyph kind={s.kind} />
              <code className="s-id">{sid}</code>
              <span className="s-t">{s.title}</span>
              {sid === m.initial ? <span className="tag">start</span> : null}
              {mark}
            </>
          );

          return summary(`state:${sid}`, sel === `state:${sid}`, content, () => stateBody(sid, s));
        })}
        <div className="blk add">
          <button type="button" className="sum" onClick={() => opened(ops.addState(m, defaultRole))}>+ Add state</button>
        </div>
      </div>
      <ProblemList problems={problems} warnings={checked.warnings} notes={notes} onPick={pick} okText={okText}
        action={conflict ? <button type="button" className="link" onClick={reload}>Reload</button> : undefined} />
    </aside>
  );

  const lines = code.split("\n").length;

  const script = (
    <div className="json-pane">
      <pre className="json dsl" aria-label="The compiled script" tabIndex={0}>
        <span className="dsl-gutter" aria-hidden="true">{Array.from({ length: lines }, (_, i) => i + 1).join("\n")}</span>
        <code>
          {tokenize(code).map((t, i) => (t.t === "ws" || t.t === "ident" ? t.v : <span key={i} className={`hl-${t.t}`}>{t.v}</span>))}
        </code>
      </pre>
    </div>
  );

  const graph = (
    <>
      <MachineGraph machine={m} view={view} height={stageHeight} onSelect={(s) => select(`state:${s}`)} draw={draw} full={full} setFull={setFull}
        readout={<div className="readout plain"><span className="rs">{m.name}</span><span className="ra">{plural(count, "state")} · click a state to edit it</span></div>} />
      {hint ? <div className="stage-foot"><span className="hint">Hover a state for + and ×, drag from + to connect, double-click to rename</span></div> : null}
    </>
  );

  const tabButton = (which: "graph" | "script", label: string) => (
    <button type="button" role="tab" id={`tab-${which}`} aria-controls="stage-panel" aria-selected={tab === which}
      className={tab === which ? "on" : undefined} onClick={() => setTab(which)}>{label}</button>
  );

  const promptState = prompting ? m.states[prompting.at] : undefined;
  const promptBranch = prompting?.branch ?? null;
  const promptText = promptState ? (promptBranch === null ? promptState.prompt ?? "" : promptState.branches?.[promptBranch]?.prompt ?? "") : "";

  const setPromptText = (v: string) => {
    if (!prompting || !promptState) return;

    if (promptBranch === null) update(ops.setField(m, prompting.at, "prompt", v));
    else setState(prompting.at, { ...promptState, branches: (promptState.branches ?? []).map((b, j) => (j === promptBranch ? { ...b, prompt: v } : b)) });
  };

  return (
    <div className="page editor">
      <PageHead back={back} title={m.name} sub={sub} actions={actions} />
      <div ref={measureRef} className="workspace">
        <section className="frame stage-ed" data-tone="select">
          <div className="stage-bar">
            <div className="switch" role="tablist" aria-label="Stage">
              {tabButton("graph", "State machine")}
              {tabButton("script", "DSL")}
            </div>
          </div>
          <div id="stage-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
            {tab === "graph" ? graph : script}
          </div>
        </section>
        {inspector}
      </div>
      {prompting && promptState ? (
        <PromptDialog open onClose={() => setPrompting(null)} path={dir ? workflowPath(dir, id) : undefined} text={promptText} refs={refsAt(m, prompting.at)}
          heading={<><code>{prompting.at}</code>{promptBranch !== null ? <> · branch <code>{promptState.branches?.[promptBranch]?.id}</code></> : null} prompt</>}
          editor={(slot) => (
            <SymbolField label="Prompt" value={promptText} machine={m} at={prompting.at} onChange={setPromptText} big
              textareaRef={slot.textareaRef} onInputType={slot.onInputType} uid={`${prompting.at}-dialog`} />
          )} />
      ) : null}
    </div>
  );
}
