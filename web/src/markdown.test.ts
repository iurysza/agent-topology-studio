import { describe, expect, it } from "vitest";
import { inline, parse } from "./markdown.tsx";
import type { Ref } from "./symbols.tsx";

const refs: Ref[] = [{ path: "inputs.dir", kind: "input", label: "dir" }];

describe("markdown", () => {
  it("reads headings by level", () => {
    const b = parse("# One\n## Two\n### Three\n#### not", refs);
    expect(b.map((x) => (x.t === "h" ? x.level : x.t))).toEqual([1, 2, 3, "p"]);
  });

  it("nests a list one level", () => {
    const [l] = parse("- a\n  - a1\n  - a2\n- b", refs);
    expect(l.t).toBe("list");
    if (l.t !== "list") return;
    expect(l.items).toHaveLength(2);
    expect(l.items[0].sub?.items).toHaveLength(2);
    expect(l.items[1].sub).toBeUndefined();
  });

  it("leaves fenced code untouched", () => {
    const [c] = parse("```\n**x** {{inputs.dir}}\n- y\n```", refs);
    expect(c).toEqual({ t: "code", text: "**x** {{inputs.dir}}\n- y" });
  });

  it("keeps a chip inside a list item", () => {
    const [l] = parse("1. read {{inputs.dir}}", refs);
    if (l.t !== "list") throw new Error("not a list");
    expect(l.ordered).toBe(true);
    const [t] = l.items[0].kids;
    expect(t.t === "text" && t.segs[1]).toEqual({ text: "{{inputs.dir}}", path: "inputs.dir", kind: "input" });
  });

  it("reads bold followed by a chip", () => {
    const n = inline("**Goal** for {{inputs.dir}}", refs);
    expect(n[0]).toEqual({ t: "b", kids: [{ t: "text", segs: [{ text: "Goal" }] }] });
    expect(n[1].t === "text" && n[1].segs.map((s) => ("kind" in s ? s.kind : s.text))).toEqual([" for ", "input"]);
  });

  it("keeps single newlines inside one paragraph by default", () => {
    const [p] = parse("a\nb", refs);
    expect(p).toEqual({ t: "p", kids: [{ t: "text", segs: [{ text: "a\nb" }] }] });
  });

  it("soft mode breaks single newlines and reads label lines", () => {
    const b = parse("Vote on this.\nBe brief.\nSkeptic:\n{{inputs.dir}}\nPrior verdict:\nnone\n\nThis line is far too long to be a label line at all:", refs, { soft: true });
    expect(b.map((x) => x.t)).toEqual(["p", "def", "def", "p"]);
    expect(b[0].t === "p" && b[0].kids.map((k) => k.t)).toEqual(["text", "br", "text"]);
    expect(b[1]).toMatchObject({ t: "def", label: "Skeptic" });
    expect(b[1].t === "def" && b[1].kids[0].t === "text" && b[1].kids[0].segs[0]).toMatchObject({ kind: "input" });
    expect(b[2]).toMatchObject({ t: "def", label: "Prior verdict" });
  });

  it("a label owns only the line under it", () => {
    expect(parse("History:\none\ntwo\nthree", refs, { soft: true }).map((x) => x.t)).toEqual(["def", "p"]);
  });

  it("soft mode still reads a table", () => {
    const [t] = parse("| a | b |\n|---|---|\n| 1 | 2 |", refs, { soft: true });
    expect(t.t === "table" && t.rows).toHaveLength(1);
  });

  it("drops unsafe link targets to plain text", () => {
    expect(inline("[x](javascript:alert)", refs)[0].t).toBe("text");
    expect(inline("[x](https://a.b)", refs)[0]).toMatchObject({ t: "a", href: "https://a.b" });
  });
});
