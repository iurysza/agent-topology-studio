// Small pieces every page uses: the page head, a copyable path, the problem list and two list-page hooks.
import { useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { loadDir } from "./api.ts";
import { splitPath } from "./paths.ts";

/** The project root once known, "" before. */
export function useDir(): string {
  const [dir, setDir] = useState("");

  useEffect(() => {
    let live = true;

    loadDir().then((d) => {
      if (live) setDir(d);
    });

    return () => {
      live = false;
    };
  }, []);

  return dir;
}

const COPIED_MS = 1400;

/** A path as a button: the folder part may ellipsize, the file name always shows. A click copies the full path. */
export function CopyPath({ path, shown = path }: { path: string; shown?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;

      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  const confirm = () => {
    if (!mounted.current) return;

    if (timer.current !== null) clearTimeout(timer.current);
    setCopied(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setCopied(false);
    }, COPIED_MS);
  };

  const copy = () => {
    const board = navigator.clipboard;

    if (!board) return;
    board.writeText(path).then(confirm, () => undefined);
  };

  const [head, tail] = splitPath(shown);

  return (
    <button type="button" className={copied ? "path done" : "path"} title={`${path}\nClick to copy`} aria-label={`Copy path ${path}`} onClick={copy}>
      <span className="p-head"><bdi>{head}</bdi></span>
      <span className="p-tail">{tail}</span>
      <span className="p-ok" aria-live="polite">{copied ? "Copied" : ""}</span>
    </button>
  );
}

export const Sep = () => <span className="sep" aria-hidden="true" />;

/** A small rounded square, tinted by tone. */
export const Block = ({ tone, size = 10 }: { tone?: string; size?: number }) => (
  <svg className={`block t-${tone ?? "none"}`} width={size} height={size} viewBox="0 0 10 10" aria-hidden="true">
    <rect x="1" y="1" width="8" height="8" rx="2.4" />
  </svg>
);

/** Text with each `backticked` run shown as code. */
export function Rich({ text }: { text: string }) {
  const parts = text.split(/`([^`]+)`/);

  return <>{parts.map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : part))}</>;
}

const BackChevron = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8.6 3.4 5 7l3.6 3.6" />
  </svg>
);

export function PageHead({ back, title, sub, actions }: {
  back?: { label: string; href: string }; title: ReactNode; sub?: ReactNode; actions?: ReactNode;
}) {
  return (
    <header className="top">
      {back ? <a className="back" href={back.href}><BackChevron />{back.label}</a> : null}
      <div className="head-row">
        <div className="head-text">
          <h1>{title}</h1>
          {sub ? <div className="sub">{sub}</div> : null}
        </div>
        {actions ? <div className="actions">{actions}</div> : null}
      </div>
    </header>
  );
}

const FIRST_ITEMS = 4;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The heading of a problem list: problems first, then warnings, else the all-clear text. */
function ProblemHeading({ problems, warnings, okText }: { problems: number; warnings: number; okText: string }) {
  if (problems > 0) return <span className="p-h"><Block tone="waiting" size={9} />{plural(problems, "problem")}, not saved</span>;

  if (warnings > 0) return <span className="p-h"><Block size={9} />{plural(warnings, "warning")}</span>;

  return <span className="quiet">{okText}</span>;
}

export function ProblemList({ problems, warnings = [], notes = [], onPick, okText, action }: {
  problems: string[]; warnings?: string[]; notes?: string[]; onPick?: (p: string) => void; okText: string; action?: ReactNode;
}) {
  const [all, setAll] = useState(false);
  const items = [...problems, ...warnings];
  const visible = all ? items : items.slice(0, FIRST_ITEMS);
  const hidden = items.length - FIRST_ITEMS;

  return (
    <div className="problems" role="status">
      <ProblemHeading problems={problems.length} warnings={warnings.length} okText={okText} />
      {action}
      {visible.map((text, i) => (
        <button key={`${i}:${text}`} type="button" className="p" onClick={() => onPick?.(text)}><Rich text={text} /></button>
      ))}
      {hidden > 0 ? <button type="button" className="link" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show ${hidden} more`}</button> : null}
      {notes.map((note, i) => <span key={`${i}:${note}`} className="p-note"><Rich text={note} /></span>)}
    </div>
  );
}

/** The clock, refreshed every `ms`. */
export const useNow = (ms: number): number => {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);

    return () => clearInterval(t);
  }, [ms]);

  return now;
};

const isTyping = (t: EventTarget | null) => t instanceof Element && t.matches("input, textarea, select");

const actsOnEnter = (t: EventTarget | null) => t instanceof Element && t.closest("a[href], button") !== null;

/** Where a list selection lands after a move key, or null when the key does not move it. */
function moved(key: string, at: number, count: number): number | null {
  if (key === "j" || key === "ArrowDown") return count > 0 ? Math.min(at + 1, count - 1) : -1;

  if (key === "k" || key === "ArrowUp") return count > 0 ? Math.max(at - 1, 0) : -1;

  return null;
}

/**
 * j/k and the arrows move a selection through a list page, and Enter opens it. Returns the selected index, -1 until a
 * key moves it. With `selection`, that state holds the index instead of an internal one.
 */
export function useListKeys(count: number, open: (i: number) => void, extra?: (e: KeyboardEvent) => void,
  selection?: [number, Dispatch<SetStateAction<number>>]): number {
  const own = useState(-1);
  const [raw, setRaw] = selection ?? own;
  const at = Math.min(raw, count - 1);
  const latest = useRef({ at, count, open, extra, setRaw });

  useEffect(() => {
    latest.current = { at, count, open, extra, setRaw };
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const now = latest.current;
      const next = moved(e.key, now.at, now.count);

      if (next !== null) {
        e.preventDefault();
        now.setRaw(next);

        return;
      }

      if (e.key === "Enter") {
        if (actsOnEnter(e.target)) return;

        if (now.at >= 0) {
          now.open(now.at);

          return;
        }
      }

      now.extra?.(e);
    };

    window.addEventListener("keydown", onKey);

    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return at;
}
