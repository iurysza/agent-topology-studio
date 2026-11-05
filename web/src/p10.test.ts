import { describe, expect, it } from "vitest";
import { exhausted, fresh, historyKey, step } from "./history.ts";
import { rolePath, splitPath, workflowPath } from "./paths.ts";
import { tokenize } from "./highlight.ts";

describe("prompt dialog undo and redo", () => {
  it("edits fill undo and clear redo; undo and redo move one step across", () => {
    let h = step(step(fresh, "insertText"), "insertText");
    expect(h).toEqual({ undo: 2, redo: 0 });
    h = step(h, "historyUndo"); expect(h).toEqual({ undo: 1, redo: 1 });
    h = step(h, "historyRedo"); expect(h).toEqual({ undo: 2, redo: 0 });
    h = step(step(h, "historyUndo"), "deleteContentBackward"); expect(h).toEqual({ undo: 2, redo: 0 });
  });
  it("never goes below zero, and an undo that changed nothing empties that side", () => {
    expect(step(fresh, "historyUndo")).toEqual({ undo: 0, redo: 1 });
    expect(exhausted({ undo: 3, redo: 1 }, "undo")).toEqual({ undo: 0, redo: 1 });
    expect(exhausted({ undo: 3, redo: 1 }, "redo")).toEqual({ undo: 3, redo: 0 });
  });
  it("maps the keys", () => {
    expect(historyKey({ key: "z", metaKey: true })).toBe("undo");
    expect(historyKey({ key: "Z", metaKey: true, shiftKey: true })).toBe("redo");
    expect(historyKey({ key: "y", ctrlKey: true })).toBe("redo");
    expect(historyKey({ key: "y", metaKey: true })).toBeNull();
    expect(historyKey({ key: "z" })).toBeNull();
    expect(historyKey({ key: "z", metaKey: true, altKey: true })).toBeNull();
  });
});

describe("file paths", () => {
  it("joins the project root with Pi's folders, without doubled slashes", () => {
    expect(workflowPath("/p/proj", "build")).toBe("/p/proj/.pi/workflows/build.js");
    expect(workflowPath("/p/proj/", "build")).toBe("/p/proj/.pi/workflows/build.js");
    expect(rolePath("~/x", "coder")).toBe("~/x/.pi/agents/coder.md");
    expect(rolePath("", "coder")).toBe(".pi/agents/coder.md");
  });
  it("splits before the file name so only the folder ellipsizes", () => {
    expect(splitPath("/a/b/c.js")).toEqual(["/a/b", "/c.js"]);
    expect(splitPath("c.js")).toEqual(["", "c.js"]);
  });
});

describe("tokenize", () => {
  const code = 'const url = "http://x.dev"; // a comment\nlet t = `hi ${name} // not a comment`; /* block */ f(1.5, 0x1f);';
  const toks = tokenize(code);
  it("gives the input back when joined", () => { expect(toks.map((t) => t.v).join("")).toBe(code); });
  it("keeps // inside strings and template literals as string", () => {
    expect(toks.filter((t) => t.t === "str").map((t) => t.v)).toEqual(['"http://x.dev"']);
    expect(toks.filter((t) => t.t === "tpl").map((t) => t.v)).toEqual(["`hi ", " // not a comment`"]);
    expect(toks.filter((t) => t.t === "cmt").map((t) => t.v)).toEqual(["// a comment", "/* block */"]);
  });
  it("tells keywords, identifiers, numbers and punctuation apart", () => {
    expect(toks.filter((t) => t.t === "kw").map((t) => t.v)).toEqual(["const", "let"]);
    expect(toks.filter((t) => t.t === "num").map((t) => t.v)).toEqual(["1.5", "0x1f"]);
    expect(toks.find((t) => t.v === "url")?.t).toBe("ident");
    expect(toks.find((t) => t.v === "=")?.t).toBe("op");
  });
});
