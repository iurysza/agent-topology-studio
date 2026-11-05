// Read-only prompts as a small Markdown: paragraphs, `#`–`###` headings, lists with one nesting level, fenced code,
// and inline code, bold, italic and links. Every plain run goes through `segments`, so `{{ref}}` chips survive
// everywhere except inside code. No HTML is ever passed through.
import type { ReactNode } from "react";
import { segments, type Ref, type Segment } from "./symbols.tsx";
import { Chip } from "./chipinfo.tsx";

// ---------- the pure part ----------

export type Inline =
  | { t: "text"; segs: Segment[] }
  | { t: "code"; text: string }
  | { t: "b"; kids: Inline[] }
  | { t: "i"; kids: Inline[] }
  | { t: "a"; href: string; kids: Inline[] }
  | { t: "br" };
export interface Item { kids: Inline[]; sub?: List }
export interface List { t: "list"; ordered: boolean; items: Item[] }
export type Block =
  | { t: "h"; level: 1 | 2 | 3; kids: Inline[] }
  | { t: "p"; kids: Inline[] }
  | { t: "code"; text: string }
  | { t: "quote"; kids: Inline[] }
  | { t: "hr" }
  | { t: "table"; head: Inline[][]; rows: Inline[][][] }
  | { t: "def"; label: string; kids: Inline[] }
  | List;
/** `soft`: a single newline breaks the line, and a line that is only `Word words:` labels the lines under it. */
export interface Opts { soft?: boolean }

/** A short line that is only a label: `Skeptic:` or `Prior verdict:`. */
export const LABEL = /^\s*[A-Za-z][\w'-]*(?: [\w'-]+)*:\s*$/;
const isLabel = (line: string) => line.trim().length <= 40 && LABEL.test(line);
const broken = (ls: string[], refs: Ref[]): Inline[] => ls.flatMap((l, i) => (i ? [{ t: "br" } as Inline] : []).concat(inline(l, refs)));

const INLINE = /`([^`\n]+)`|\*\*(.+?)\*\*|\*([^*\s](?:[^*\n]*?[^*\s])?)\*|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
const SAFE = /^(https?:|mailto:|\/|#|\.)/i;

/** Inline Markdown over one run of text; plain runs are cut into placeholder segments. */
export function inline(text: string, refs: Ref[]): Inline[] {
  const out: Inline[] = []; let at = 0;
  const plain = (s: string) => { if (s) out.push({ t: "text", segs: segments(s, refs) }); };
  for (const m of text.matchAll(INLINE)) {
    plain(text.slice(at, m.index)); at = m.index + m[0].length;
    if (m[1] !== undefined) out.push({ t: "code", text: m[1] });
    else if (m[2] !== undefined) out.push({ t: "b", kids: inline(m[2], refs) });
    else if (m[3] !== undefined) out.push({ t: "i", kids: inline(m[3], refs) });
    else if (SAFE.test(m[5])) out.push({ t: "a", href: m[5], kids: inline(m[4], refs) });
    else plain(m[0]);
  }
  plain(text.slice(at));
  return out;
}

const LI = /^(\s*)([-*]|\d+\.)\s+(.*)$/;
const ROW = /^\s*\|.*\|\s*$/, RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

/** Block Markdown: blank lines split paragraphs; a list item indented by two or more spaces nests one level. */
export function parse(text: string, refs: Ref[], opts: Opts = {}): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n"), out: Block[] = [];
  let para: string[] = [], label: string | null = null;
  const flush = () => {
    if (label !== null) out.push({ t: "def", label, kids: broken(para, refs) });
    else if (para.length) out.push({ t: "p", kids: opts.soft ? broken(para, refs) : inline(para.join("\n"), refs) });
    para = []; label = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush(); const body: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) body.push(lines[i]);
      out.push({ t: "code", text: body.join("\n") }); continue;
    }
    if (ROW.test(line) && RULE.test(lines[i + 1] ?? "")) {
      flush(); const head = cells(line).map((c) => inline(c, refs)), rows: Inline[][][] = [];
      for (i += 2; i < lines.length && ROW.test(lines[i]); i++) rows.push(cells(lines[i]).map((c) => inline(c, refs)));
      i--; out.push({ t: "table", head, rows }); continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push({ t: "hr" }); continue; }
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) { flush(); const last = out[out.length - 1]; if (last?.t === "quote") last.kids.push({ t: "text", segs: [{ text: "\n" }] }, ...inline(q[1], refs)); else out.push({ t: "quote", kids: inline(q[1], refs) }); continue; }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) { flush(); out.push({ t: "h", level: h[1].length as 1 | 2 | 3, kids: inline(h[2], refs) }); continue; }
    const li = LI.exec(line);
    if (li) {
      flush();
      const ordered = /\d/.test(li[2]), top = li[1].length < 2;
      const last = out[out.length - 1];
      const list: List = last?.t === "list" && (!top || last.ordered === ordered) ? last : { t: "list", ordered, items: [] };
      if (list !== last) out.push(list);
      const item: Item = { kids: inline(li[3], refs) };
      const parent = list.items[list.items.length - 1];
      if (!top && parent) (parent.sub ??= { t: "list", ordered, items: [] }).items.push(item);
      else list.items.push(item);
      continue;
    }
    if (!line.trim()) flush();
    else if (opts.soft && isLabel(line)) { flush(); label = line.trim().slice(0, -1); }
    else { if (label !== null && para.length) flush(); para.push(opts.soft ? line.trim() : line); }
  }
  flush();
  return out;
}

// ---------- the drawn part ----------

function Inl({ nodes, refs }: { nodes: Inline[]; refs: Ref[] }) {
  return <>{nodes.map((n, i): ReactNode => {
    if (n.t === "br") return <br key={i} />;
    if (n.t === "code") return <code key={i}>{n.text}</code>;
    if (n.t === "b") return <strong key={i}><Inl nodes={n.kids} refs={refs} /></strong>;
    if (n.t === "i") return <em key={i}><Inl nodes={n.kids} refs={refs} /></em>;
    if (n.t === "a") return <a key={i} href={n.href} target="_blank" rel="noopener noreferrer"><Inl nodes={n.kids} refs={refs} /></a>;
    return n.segs.map((s, j) => {
      if (!("kind" in s)) return <span key={`${i}.${j}`}>{s.text}</span>;
      const r = refs.find((x) => x.path === s.path);
      return <Chip key={`${i}.${j}`} info={r} path={s.path} kind={s.kind} />;
    });
  })}</>;
}

function ListView({ list, refs }: { list: List; refs: Ref[] }) {
  const items = list.items.map((it, i) => <li key={i}><Inl nodes={it.kids} refs={refs} />{it.sub ? <ListView list={it.sub} refs={refs} /> : null}</li>);
  return list.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
}

/** A read-only prompt drawn as Markdown with reference chips. */
export function Markdown({ text, refs, className = "md", soft = false }: { text: string; refs: Ref[]; className?: string; soft?: boolean }) {
  return (
    <div className={`${className}${soft ? " soft" : ""}`}>
      {parse(text, refs, { soft }).map((b, i) => {
        if (b.t === "def") return <div key={i} className="md-def"><span className="md-dt">{b.label}</span>{b.kids.length ? <p><Inl nodes={b.kids} refs={refs} /></p> : null}</div>;
        if (b.t === "list") return <ListView key={i} list={b} refs={refs} />;
        if (b.t === "code") return <pre key={i}><code>{b.text}</code></pre>;
        if (b.t === "hr") return <hr key={i} />;
        if (b.t === "quote") return <blockquote key={i}><Inl nodes={b.kids} refs={refs} /></blockquote>;
        if (b.t === "table") return (
          <table key={i}><thead><tr>{b.head.map((c, j) => <th key={j}><Inl nodes={c} refs={refs} /></th>)}</tr></thead>
            <tbody>{b.rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k}><Inl nodes={c} refs={refs} /></td>)}</tr>)}</tbody></table>
        );
        if (b.t === "h") { const H = `h${b.level + 2}` as "h3" | "h4" | "h5"; return <H key={i}><Inl nodes={b.kids} refs={refs} /></H>; }
        return <p key={i}><Inl nodes={b.kids} refs={refs} /></p>;
      })}
    </div>
  );
}
