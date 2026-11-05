// Roles: the agents in .pi/agents. The list shows who each one is and how much the workflows lean on it;
// a role's page edits its frontmatter as fields and its prompt as prose. Like a workflow, it saves only on Save or ⌘S.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, currentApi, FALLBACK_TOOLS, loadCatalog, type Catalog, type RoleFields } from "./api.ts";
import { href } from "./route.ts";
import { Markdown } from "./markdown.tsx";
import { Select } from "./select.tsx";
import { TokenField } from "./tokens.tsx";
import { PI_COLORS, swatch } from "./graph.tsx";
import { setUnsaved } from "./unsaved.ts";
import { CopyPath, PageHead, Sep, useDir, useListKeys } from "./parts.tsx";
import { PromptDialog } from "./prompt-dialog.tsx";
import { ExpandIcon } from "./symbols.tsx";
import { rolePath } from "./paths.ts";
import type { Machine, Project, Role } from "./types.ts";

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"];
const NAME = /^[a-z][a-z0-9-]*$/;

/** Where a role is used: one entry per state or fanout branch that names it. */
export function usesOf(machines: Machine[], role: string): { workflow: string; at: string }[] {
  const out: { workflow: string; at: string }[] = [];
  for (const m of machines) for (const [sid, s] of Object.entries(m.states)) {
    if (s.role === role) out.push({ workflow: m.id, at: sid });
    for (const b of s.branches ?? []) if (b.role === role) out.push({ workflow: m.id, at: `${sid}.${b.id}` });
  }
  return out;
}

/** The project plus every editable workflow's machine, for the used-by counts. */
function useProject() {
  const [p, setP] = useState<{ project: Project; machines: Machine[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.project().then(async (project) => {
      const machines = await Promise.all(project.workflows.filter((w) => w.editable).map((w) => w.machine ? Promise.resolve(w.machine) : api.workflow(w.id).then((l) => l.machine).catch(() => undefined)));
      setP({ project, machines: machines.filter((m): m is Machine => !!m) });
    }).catch((e) => setErr((e as Error).message));
  }, []);
  return { p, err };
}

export function Roles() {
  const { p, err } = useProject();
  const [asking, setAsking] = useState(false);
  const rows = p?.project.roles ?? [];
  const open = useCallback((i: number) => { const r = rows[i]; if (r) location.hash = href(`/roles/${encodeURIComponent(r.name)}`); }, [rows]);
  const extra = useCallback((e: KeyboardEvent) => { if (e.key === "n") { e.preventDefault(); setAsking(true); } }, []);
  const sel = useListKeys(rows.length, open, extra);
  if (err) return <div className="page"><PageHead title="Roles" sub="Could not open the project" /><p className="problem" role="alert">{err}</p></div>;
  if (!p) return <div className="loading" />;
  return (
    <div className="page">
      <PageHead title="Roles" sub={<code>.pi/agents</code>} actions={<button className="pill primary" onClick={() => setAsking(true)}>New role</button>} />
      {asking ? <NewRole taken={rows.map((r) => r.name)} models={[...new Set(rows.map((r) => r.model).filter((x): x is string => !!x))].sort()} onCancel={() => setAsking(false)} /> : null}
      <div className="rows">
        {rows.map((r, i) => {
          const n = usesOf(p.machines, r.name).length;
          return (
            <div key={r.name} className={`row rrow${sel === i ? " sel" : ""}`} data-row={i}>
              <span className="r-main">
                <a className="r-title row-link" href={href(`#/roles/${encodeURIComponent(r.name)}`)}><span className={swatch(r.color)} aria-hidden="true" /><code>{r.name}</code></a>
                <span className="r-sub"><span className="ell">{r.description || "No description"}</span></span>
              </span>
              <span className="r-side">
                <span className="r-meta">{r.model ? <code className="model">{r.model}</code> : <span className="quiet">default model</span>}<Sep /><span className={n ? "" : "quiet"}>{n ? `used ${n}×` : "unused"}</span></span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const TOOLSETS = { read: "read, bash, grep, find, ls", write: "read, bash, grep, find, ls, edit, write" } as const;
type Toolset = keyof typeof TOOLSETS | "custom";

function NewRole({ taken, models, onCancel }: { taken: string[]; models: string[]; onCancel: () => void }) {
  const [name, setName] = useState(""), [description, setDescription] = useState(""), [color, setColor] = useState("");
  const [model, setModel] = useState(""), [thinking, setThinking] = useState(""), [toolset, setToolset] = useState<Toolset>("read"), [custom, setCustom] = useState("");
  const [prompt, setPrompt] = useState(""), [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const [c] = useState(currentApi);
  useEffect(() => { input.current?.focus(); }, []);
  const create = async () => {
    const v = name.trim();
    if (!NAME.test(v)) { setProblem("Start with a letter; use lowercase letters, digits and hyphens."); return; }
    if (taken.includes(v)) { setProblem(`A role called ${v} already exists.`); return; }
    const tools = list(toolset === "custom" ? custom : TOOLSETS[toolset]);
    const body = `\n${prompt.trim() || `You are the ${v}.`}\n`;
    const fm: RoleFields = { description: description.trim() || null, color: color || null, model: model.trim() || null, thinking: thinking || null, tools: tools.length ? tools : null, skills: null };
    setBusy(true);
    try {
      // Create takes only some fields today, so the full frontmatter follows as a save against the new file's hash.
      const made = await c.createRole({ name: v, description: fm.description ?? undefined, color: fm.color ?? undefined, model: fm.model ?? undefined, body });
      await c.saveRole(v, fm, body, made.hash);
      location.hash = href(`/roles/${encodeURIComponent(v)}`);
    } catch (e) { setProblem((e as Error).message); setBusy(false); }
  };
  const stop = (e: React.KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
  return (
    <form className="new-ask new-role" onSubmit={(e) => { e.preventDefault(); create(); }} onKeyDown={stop} aria-label="New role">
      <div className="nr-fm">
        <label className="field"><span className="k label">Name</span>
          <input ref={input} className="mono" value={name} spellCheck={false} placeholder="tester" aria-label="Role name"
            onChange={(e) => { setName(e.target.value); setProblem(null); }} />
          {problem ? <span className="hint err" role="alert">{problem}</span> : <span className="hint">Becomes .pi/agents/{name.trim() || "name"}.md</span>}
        </label>
        <label className="field"><span className="k label">Description</span>
          <input className="prose" value={description} placeholder="What it is for" onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div className="two">
          <ColorField value={color} onChange={setColor} />
          <div className="field"><span className="k label">Thinking</span>
            <ThinkingSelect value={thinking} onChange={setThinking} />
          </div>
        </div>
        <label className="field"><span className="k label">Model</span>
          <input className="mono" value={model} spellCheck={false} placeholder={models[0] ?? "provider/model"} list="nr-models" onChange={(e) => setModel(e.target.value)} />
          <datalist id="nr-models">{models.map((x) => <option key={x} value={x} />)}</datalist>
          <span className="hint">Leave empty for Pi's default model.</span>
        </label>
        <div className="field" role="group" aria-labelledby="nr-tools"><span className="k label" id="nr-tools">Tools</span>
          <div className="seg nr-seg" role="radiogroup" aria-label="Tools">
            {([["read", "Read-only"], ["write", "Read and write"], ["custom", "Custom"]] as const).map(([v, l]) => (
              <button type="button" role="radio" key={v} aria-checked={toolset === v} className={toolset === v ? "on" : ""}
                onClick={() => { if (v === "custom" && toolset !== "custom" && !custom) setCustom(TOOLSETS[toolset]); setToolset(v); }}>{l}</button>
            ))}
          </div>
          {toolset === "custom"
            ? <input className="mono" value={custom} spellCheck={false} placeholder="read, bash, edit" aria-label="Custom tools" autoFocus onChange={(e) => setCustom(e.target.value)} />
            : null}
          <span className="hint">{toolset === "custom" ? "Comma-separated. Leave empty for Pi's default set." : <code>{TOOLSETS[toolset]}</code>}</span>
        </div>
      </div>
      <label className="field nr-body"><span className="k label">Prompt</span>
        <textarea value={prompt} rows={6} spellCheck onChange={(e) => setPrompt(e.target.value)}
          placeholder={`You are the ${name.trim() || "<name>"}. What you look for, what you must not do, the shape of your reply.`} />
        <span className="hint">The agent's system prompt, in Markdown. You can change it later.</span>
      </label>
      <div className="nr-foot">
        <button className="pill quiet" type="button" onClick={onCancel}>Cancel</button>
        <button className="pill primary" type="submit" disabled={busy}>{busy ? "Creating…" : "Create role"}</button>
      </div>
    </form>
  );
}

function ColorField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="field color-f"><span className="k label">Colour</span>
      <Select value={value} onChange={onChange} label="Colour" width={180}
        options={[{ value: "", label: "None", swatch: swatch(null) },
          ...(value && !PI_COLORS.includes(value) ? [{ value, label: value, description: "Unknown to Pi", swatch: swatch(null) }] : []),
          ...PI_COLORS.map((c) => ({ value: c, label: c, swatch: swatch(c) }))]} />
      <span className="hint">&nbsp;</span>
    </div>
  );
}

function ThinkingSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return <Select value={value} onChange={onChange} label="Thinking" width={180}
    options={[{ value: "", label: "Default" }, ...(value && !THINKING.includes(value) ? [{ value, label: value }] : []), ...THINKING.map((t) => ({ value: t, label: t }))]} />;
}

/** Pi's tools and skills for the token fields' suggestions. */
function useCatalog() {
  const [c, setC] = useState<Catalog>({ tools: FALLBACK_TOOLS, skills: [] });
  useEffect(() => { let live = true; loadCatalog().then((x) => { if (live) setC(x); }); return () => { live = false; }; }, []);
  return c;
}

// ---------- one role ----------

type Draft = { description: string; color: string; model: string; thinking: string; tools: string; skills: string; body: string };
type Save = { kind: "saved" } | { kind: "unsaved" } | { kind: "saving" } | { kind: "failed"; why: string } | { kind: "conflict"; why: string };
const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const toDraft = (r: Role, body: string): Draft => ({ description: r.description ?? "", color: r.color ?? "", model: r.model ?? "", thinking: r.thinking ?? "", tools: (r.tools ?? []).join(", "), skills: (r.skills ?? []).join(", "), body });
const fields = (d: Draft): RoleFields => ({ description: d.description.trim() || null, color: d.color || null, model: d.model.trim() || null, thinking: d.thinking || null, tools: list(d.tools).length ? list(d.tools) : null, skills: list(d.skills).length ? list(d.skills) : null });
/** Two drafts that would write the same file are the same. */
const same = (a: Draft, b: Draft) => JSON.stringify([fields(a), a.body]) === JSON.stringify([fields(b), b.body]);

export function RolePage({ name }: { name: string }) {
  const { p } = useProject();
  const [d, setD] = useState<Draft | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [save, setSave] = useState<Save>({ kind: "saved" });
  const [view, setView] = useState<"write" | "preview">("write");
  const [writing, setWriting] = useState(false);
  const dir = useDir();
  const catalog = useCatalog();
  const base = useRef<{ d: Draft; hash: string } | null>(null);
  const busy = useRef(false), again = useRef(false), latest = useRef<Draft | null>(null);
  const [c] = useState(currentApi);
  useEffect(() => {
    c.role(name).then((r) => { const x = toDraft(r.role, r.body); base.current = { d: x, hash: r.hash }; latest.current = x; setD(x); })
      .catch((e) => setErr(e instanceof ApiError && e.status === 404 ? `No role called ${name} in .pi/agents.` : (e as Error).message));
  }, [name, c]);

  // One save in flight; a change during it queues one more. A conflict stops saving until reload.
  const run = useCallback(async () => {
    if (!base.current || !latest.current) return;
    if (busy.current) { again.current = true; return; }
    const draft = latest.current;
    if (same(draft, base.current.d)) { setSave({ kind: "saved" }); return; }
    busy.current = true; setSave({ kind: "saving" });
    try {
      const r = await c.saveRole(name, fields(draft), draft.body, base.current.hash);
      base.current = { d: draft, hash: r.hash };
      setSave(same(latest.current, draft) ? { kind: "saved" } : { kind: "unsaved" });
    } catch (e) {
      busy.current = false; again.current = false;
      setSave(e instanceof ApiError && e.status === 409 ? { kind: "conflict", why: "Someone changed this file on disk. Reload to see their version; your edits here are not saved." } : { kind: "failed", why: (e as Error).message });
      return;
    }
    busy.current = false;
    if (again.current) { again.current = false; run(); }
  }, [name, c]);
  // No autosave: an edit only marks the page unsaved and raises the leaving guard.
  const dirty = !!d && !!base.current && !same(d, base.current.d);
  useEffect(() => {
    if (!d) return;
    latest.current = d;
    setUnsaved(dirty, `the role “${name}”`);
    if (dirty) setSave((s) => (s.kind === "saved" ? { kind: "unsaved" } : s));
  }, [d, dirty]);
  useEffect(() => () => setUnsaved(false), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); if (save.kind !== "conflict") run(); } };
    addEventListener("keydown", onKey); return () => removeEventListener("keydown", onKey);
  }, [run, save.kind]);

  const back = { label: "Roles", href: href("#/roles") };
  if (err) return <div className="page"><PageHead back={back} title={name} sub="Could not open this role" /><p className="problem" role="alert">{err}</p></div>;
  if (!d) return <div className="loading" />;
  const set = (patch: Partial<Draft>) => setD({ ...d, ...patch });
  // Discard puts the last saved draft back; nothing to fetch, the page holds it.
  const discard = () => { if (!base.current) return; setUnsaved(false); setWriting(false); setD(base.current.d); setSave({ kind: "saved" }); };
  const file = dir ? rolePath(dir, name) : "";
  const uses = p ? usesOf(p.machines, name) : [];
  const status = save.kind === "saving" ? "saving" : save.kind === "failed" ? "not saved" : save.kind === "conflict" ? "changed on disk" : save.kind === "unsaved" ? "unsaved" : "saved";
  return (
    <div className="page role-page">
      <PageHead back={back}
        title={<span className="role-title"><span className={swatch(d.color)} aria-hidden="true" /><code>{name}</code></span>}
        sub={<>{file ? <CopyPath path={file} /> : <code>.pi/agents/{name}.md</code>}<Sep /><span className={`save-st s-${save.kind}`} aria-live="polite">{status}</span></>}
        actions={save.kind === "conflict" ? <button className="pill" onClick={() => { setUnsaved(false); location.reload(); }}>Reload</button>
          : <>{dirty && save.kind !== "saving" ? <button className="pill quiet" onClick={discard} title="Drop unsaved changes">Discard</button> : null}<button className={dirty ? "pill primary" : "pill"} disabled={!dirty || save.kind === "saving"} onClick={run} title="Save now (⌘S)">Save</button></>} />
      {save.kind === "failed" || save.kind === "conflict" ? <p className="problem" role="alert">{save.why}</p> : null}
      <div className="role-grid">
        <section className="role-fm" aria-label="Settings">
          <label className="field"><span className="k label">Description</span>
            <input className="prose" value={d.description} placeholder="What it is for" onChange={(e) => set({ description: e.target.value })} />
            <span className="hint">The inspector's role picker shows it after the name.</span>
          </label>
          <div className="two">
            <ColorField value={d.color} onChange={(color) => set({ color })} />
            <div className="field"><span className="k label">Thinking</span>
              <ThinkingSelect value={d.thinking} onChange={(thinking) => set({ thinking })} />
            </div>
          </div>
          <label className="field"><span className="k label">Model</span>
            <input className="mono" value={d.model} spellCheck={false} placeholder="provider/model" onChange={(e) => set({ model: e.target.value })} />
          </label>
          <TokenField label="Tools" value={d.tools} suggestions={catalog.tools} placeholder="read, bash, edit" onChange={(tools) => set({ tools })}
            hint="Leave empty for Pi's default set." />
          <TokenField label="Skills" kind="skill" value={d.skills} suggestions={catalog.skills} placeholder="coding-standards" onChange={(skills) => set({ skills })}
            hint={catalog.skills.length ? "Skills the agent loads." : "Type a skill name and press Enter."} />
          <div className="field used">
            <span className="k label">Used by</span>
            {uses.length ? (
              <ul className="used-l">{uses.map((u) => <li key={u.workflow + u.at}><a href={href(`#/w/${encodeURIComponent(u.workflow)}`)}><code>{u.workflow}</code><Sep /><code>{u.at}</code></a></li>)}</ul>
            ) : <span className="hint">No workflow uses this role yet.</span>}
          </div>
        </section>
        <div className="field role-body">
          <div className="field-h rb-h"><label className="k label" htmlFor="role-prompt">Prompt</label>
            <div className="seg sm" role="tablist" aria-label="Prompt view">
              {(["write", "preview"] as const).map((v) => <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? "on" : ""} onClick={() => setView(v)}>{v === "write" ? "Write" : "Preview"}</button>)}
            </div>
            <button type="button" className="expand" onClick={() => setWriting(true)} title="Open the prompt in a larger editor" aria-label="Expand prompt"><ExpandIcon /></button>
          </div>
          {view === "write"
            ? <textarea id="role-prompt" value={d.body} spellCheck onChange={(e) => set({ body: e.target.value })} aria-label="Role prompt" />
            : <div className="rb-preview" tabIndex={0} aria-label="Prompt preview">{d.body.trim() ? <Markdown className="md doc" text={d.body} refs={[]} /> : <p className="quiet">Nothing to preview yet.</p>}</div>}
          <span className="hint">The agent's system prompt, in Markdown. ⌘S saves.</span>
        </div>
        <PromptDialog open={writing} onClose={() => setWriting(false)} path={file || undefined} text={d.body} refs={[]}
          heading={<><span className={swatch(d.color)} aria-hidden="true" /><code>{name}</code><span className="pd-name">{d.description || "Role prompt"}</span></>}
          editor={(slot) => (
            <div className="field plain big">
              <label className="sr-only" htmlFor="role-prompt-dlg">Role prompt</label>
              <textarea id="role-prompt-dlg" ref={slot.textareaRef} value={d.body} spellCheck
                onChange={(e) => { slot.onInputType((e.nativeEvent as InputEvent).inputType ?? ""); set({ body: e.target.value }); }} />
              <span className="hint">Markdown. <kbd>⌘Z</kbd> undoes, <kbd>⇧⌘Z</kbd> redoes.</span>
            </div>
          )} />
      </div>
    </div>
  );
}
