// The state card: in full screen, a tapped state's facts, read-only. Edit leaves full screen for the inspector.
// Transition rows walk the graph: tapping one selects its target.
import type { ReactNode } from "react";
import { KindGlyph } from "./editor.tsx";
import { swatch } from "./graph.tsx";
import { Markdown } from "./markdown.tsx";
import { refsAt } from "./symbols.tsx";
import { TRANSITIONS, TransitionHint } from "./rows.tsx";
import type { Machine } from "./types.ts";
import { href } from "./route.ts";

function Prompt({ text, machine, at }: { text: string; machine: Machine; at: string }) {
  return <Markdown className="sc-prompt md" soft text={text} refs={refsAt(machine, at)} />;
}

/** A role name that opens its definition, with its swatch. */
export function RoleLink({ name, color }: { name: string; color?: string | null }) {
  return (
    <a className="sc-rolelink" href={href(`#/roles/${encodeURIComponent(name)}`)} title={`Open role ${name}`}>
      <span className={swatch(color)} aria-hidden="true" /><code>{name}</code>
    </a>
  );
}

const Sect = ({ label, children }: { label: string; children: ReactNode }) => (
  <section className="sc-sect"><span className="k label">{label}</span>{children}</section>
);

export function StateCard({ machine, id, roleColor, sheet, onWalk, onEdit, onClose, children }: {
  machine: Machine; id: string; roleColor?: (r: string) => string | null | undefined; sheet: boolean;
  onWalk: (to: string) => void; onEdit?: () => void; onClose: () => void; children?: ReactNode;
}) {
  const s = machine.states[id];
  if (!s) return null;
  const role = s.role ?? "";
  const out = Object.entries(s.output ?? {}), on = Object.entries(s.on ?? {});
  return (
    <aside className={`scard${sheet ? " sheet" : ""}`} aria-label={`State ${id}`} onPointerDown={(e) => e.stopPropagation()}>
      <header className="sc-h">
        <KindGlyph kind={s.kind} />
        <code className="sc-id">{id}</code>
        <span className="sc-title">{s.title}</span>
        {onEdit ? <button className="pill sm quiet" onClick={onEdit}>Edit</button> : null}
        {sheet ? <button className="sc-x" onClick={onClose} aria-label="Close"><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" /></svg></button> : null}
      </header>
      <div className="sc-body">
        {children}
        {s.kind !== "final" && s.kind !== "fanout" ? (
          <div className="sc-role">{role ? <RoleLink name={role} color={roleColor?.(role)} /> : <><span className={swatch(null)} aria-hidden="true" /><span className="dim">no role</span></>}</div>
        ) : null}
        {s.prompt ? <Prompt text={s.prompt} machine={machine} at={id} /> : null}
        {s.branches?.length ? (
          <Sect label="Branches">
            {s.branches.map((b) => (
              <div key={b.id} className="sc-branch">
                <div className="sc-role"><code className="sc-name">{b.id}</code><RoleLink name={b.role} color={roleColor?.(b.role)} /></div>
                {b.prompt ? <Prompt text={b.prompt} machine={machine} at={id} /> : null}
              </div>
            ))}
          </Sect>
        ) : null}
        {out.length ? (
          <Sect label="Output">
            {out.map(([name, f]) => (
              <div key={name} className="sc-field">
                <div className="sc-line"><code className="sc-name">{name}</code><span className="dim">{f.type}{f.required ? " · required" : ""}</span></div>
                {f.description ? <p className="sc-desc">{f.description}</p> : null}
              </div>
            ))}
          </Sect>
        ) : null}
        {on.length ? (
          <Sect label={TRANSITIONS.label}>
            <TransitionHint kind={s.kind} />
            {on.map(([ev, t]) => { const to = machine.states[t.to]; return (
              <button key={ev} className="sc-ev" onClick={() => onWalk(t.to)} title={`Go to ${t.to}`}>
                <span className="sc-line tr-line"><code className="sc-name tr-ev">{ev}</code><span className="sc-arrow" aria-hidden="true">→</span>
                  <span className="tr-to">{to ? <KindGlyph kind={to.kind} /> : null}<code>{t.to}</code>{to?.title ? <span className="tr-title">{to.title}</span> : null}</span></span>
                {t.description ? <span className="sc-desc">{t.description}</span> : null}
              </button>
            ); })}
          </Sect>
        ) : null}
        {s.kind === "final" ? <Sect label="Outcome"><div className="sc-line">{s.outcome ?? "success"}</div></Sect> : null}
        {s.maxVisits ? <Sect label="Max visits"><div className="sc-line"><code>{s.maxVisits}</code></div></Sect> : null}
      </div>
    </aside>
  );
}
