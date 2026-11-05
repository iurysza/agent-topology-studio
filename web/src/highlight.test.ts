import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tokenize } from "./highlight.ts";

const kinds = (code: string, t: string) => tokenize(code).filter((k) => k.t === t).map((k) => k.v);

describe("highlight tokenizer", () => {
  it("round-trips the real build.js", () => {
    const code = readFileSync(fileURLToPath(new URL("../../fixtures/playground/.pi/workflows/build.js", import.meta.url)), "utf8");
    const toks = tokenize(code);
    expect(toks.map((t) => t.v).join("")).toBe(code);
    expect(toks.some((t) => t.t === "interp")).toBe(true);
  });
  it("tokenizes ${ } inside templates recursively, nested templates too", () => {
    const code = "const s = `${machine.id} needs ${a ? `in ${b.c}` : 'x'}!`;";
    const toks = tokenize(code);
    expect(toks.map((t) => t.v).join("")).toBe(code);
    expect(kinds(code, "prop")).toEqual(["id", "c"]);
    expect(kinds(code, "tpl")).toEqual(["`", " needs ", "`in ", "`", "!`"]);
    expect(kinds(code, "interp")).toEqual(["${", "}", "${", "${", "}", "}"]);
    expect(kinds(code, "str")).toEqual(["'x'"]);
  });
  it("tells props, calls, keywords, literals, operators and punctuation apart", () => {
    const code = "if (x.done === true) await log(a.b.push(1), ...rest); return null";
    expect(kinds(code, "kw")).toEqual(["if", "await", "return"]);
    expect(kinds(code, "lit")).toEqual(["true", "null"]);
    expect(kinds(code, "prop")).toEqual(["done", "b"]);
    expect(kinds(code, "fn")).toEqual(["log", "push"]);
    expect(kinds(code, "op")).toEqual(["==="]);
    expect(kinds(code, "ident")).toEqual(["x", "a", "rest"]);
  });
  it("treats a keyword-named property as a property", () => {
    expect(kinds("s.default.if", "prop")).toEqual(["default", "if"]);
  });
});
