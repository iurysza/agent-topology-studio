// A small JavaScript tokenizer for the DSL pane. Enough for the compiled workflow script: no regex literals.
// Template literals split into `tpl` text and `interp` braces, with the code inside each ${ } scanned recursively,
// so the output stays a flat list. Joining every v gives the input back.

export type TokKind = "kw" | "lit" | "str" | "tpl" | "interp" | "cmt" | "num" | "prop" | "fn" | "ident" | "op" | "punct" | "ws";
export interface Tok { t: TokKind; v: string }

const KW = new Set(("break case catch class const continue debugger default delete do else export extends finally for from function " +
  "get if import in instanceof let new of return set static super switch throw try typeof var void while with yield async await as").split(" "));
const LIT = new Set(["true", "false", "null", "undefined", "this", "NaN", "Infinity"]);

// Order matters: comments before operators, strings before identifiers.
const RULES: [TokKind, RegExp][] = [
  ["ws", /\s+/y],
  ["cmt", /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y],
  ["str", /"(?:\\[\s\S]|[^"\\\n])*"?|'(?:\\[\s\S]|[^'\\\n])*'?/y],
  ["num", /(?:0[xXbBoO][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+)n?(?![\w$])/y],
  ["ident", /[A-Za-z_$][\w$]*/y],
  ["punct", /\.\.\.|\?\.(?!\d)|[()[\]{},;.]/y],
  ["op", /=>|[=!]==?|\*\*=?|<<=?|>>>?=?|[<>]=?|&&=?|\|\|=?|\?\?=?|[-+*/%&|^]=?|[=!~?:]/y],
];
const TPL_TEXT = /(?:\\[\s\S]|\$(?!\{)|[^`\\$])+/y;

function push(out: Tok[], t: TokKind, v: string) {
  const last = out[out.length - 1];
  if (last && last.t === t && (t === "ws" || t === "punct" || t === "tpl")) last.v += v; else out.push({ t, v });
}

// Identifier class from its neighbours: after "." (not "...") it is a property, before "(" a call.
function classify(word: string, out: Tok[], code: string, end: number): TokKind {
  if (LIT.has(word)) return "lit";
  const prev = out[out.length - 1];
  const afterDot = !!prev && prev.t === "punct" && prev.v.endsWith(".") && !prev.v.endsWith("...");
  if (!afterDot && KW.has(word)) return "kw";
  if (/^\s*\(/.test(code.slice(end, end + 40))) return "fn";
  return afterDot ? "prop" : "ident";
}

// Scans code from `at`. With `inTpl`, stops before the "}" that closes a ${ } and returns its index.
function scan(code: string, at: number, out: Tok[], inTpl: boolean): number {
  let depth = 0;
  outer: while (at < code.length) {
    const c = code[at];
    if (c === "`") { at = template(code, at, out); continue; }
    if (inTpl && c === "}" && depth === 0) return at;
    for (const [t, re] of RULES) {
      re.lastIndex = at;
      const m = re.exec(code);
      if (!m || !m[0]) continue;
      if (t === "punct") for (const ch of m[0]) depth += ch === "{" ? 1 : ch === "}" ? -1 : 0;
      push(out, t === "ident" ? classify(m[0], out, code, at + m[0].length) : t, m[0]);
      at += m[0].length;
      continue outer;
    }
    push(out, "punct", code[at++]);
  }
  return at;
}

function template(code: string, at: number, out: Tok[]): number {
  push(out, "tpl", "`");
  at++;
  while (at < code.length) {
    if (code[at] === "`") { push(out, "tpl", "`"); return at + 1; }
    if (code.startsWith("${", at)) {
      out.push({ t: "interp", v: "${" });
      at = scan(code, at + 2, out, true);
      if (at < code.length) { out.push({ t: "interp", v: "}" }); at++; }
      continue;
    }
    TPL_TEXT.lastIndex = at;
    const m = TPL_TEXT.exec(code);
    const v = m ? m[0] : code[at];
    push(out, "tpl", v);
    at += v.length;
  }
  return at;
}

export function tokenize(code: string): Tok[] {
  const out: Tok[] = [];
  scan(code, 0, out, false);
  return out;
}
