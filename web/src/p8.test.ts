import { describe, expect, it } from "vitest";
import { filterOptions, moveHighlight, typeQuery } from "./select.tsx";
import { addToken, joinTokens, parseTokens, removeToken, suggest } from "./tokens.tsx";
import { playback } from "./playback.ts";
import { parse } from "./markdown.tsx";

describe("Select keyboard", () => {
  const roles = [{ value: "auditor", label: "auditor", description: "Check evidence" }, { value: "coder", label: "coder", description: "Implements code" }, { value: "judge", label: "judge", description: "Tally ballots" }];
  it("arrows wrap and Home/End jump", () => {
    expect(moveHighlight(2, "ArrowDown", 3)).toBe(0);
    expect(moveHighlight(0, "ArrowUp", 3)).toBe(2);
    expect(moveHighlight(1, "End", 3)).toBe(2);
    expect(moveHighlight(1, "Home", 3)).toBe(0);
    expect(moveHighlight(0, "Enter", 3)).toBeNull();
    expect(moveHighlight(0, "ArrowDown", 0)).toBeNull();
  });
  it("typing builds a query; a leading space is not typing", () => {
    expect(typeQuery("", "a")).toBe("a");
    expect(typeQuery("au", "Backspace")).toBe("a");
    expect(typeQuery("", "Backspace")).toBeNull();
    expect(typeQuery("", " ")).toBeNull();
    expect(typeQuery("ArrowDown".slice(0, 0), "ArrowDown")).toBeNull();
  });
  it("filters by name first, then description", () => {
    expect(filterOptions(roles, "").map((o) => o.value)).toEqual(["auditor", "coder", "judge"]);
    expect(filterOptions(roles, "c").map((o) => o.value)).toEqual(["coder", "auditor"]);
    expect(filterOptions(roles, "ballot").map((o) => o.value)).toEqual(["judge"]);
    expect(filterOptions(roles, "zzz")).toEqual([]);
  });
});

describe("token field", () => {
  it("round-trips the comma string, trimming and dropping repeats", () => {
    expect(parseTokens(" read, bash,,read ,edit ")).toEqual(["read", "bash", "edit"]);
    expect(joinTokens(parseTokens("read,bash"))).toBe("read, bash");
    expect(parseTokens("")).toEqual([]);
    expect(joinTokens([])).toBe("");
  });
  it("adds, ignores blanks and repeats, removes by index", () => {
    expect(addToken(["read"], " bash, ")).toEqual(["read", "bash"]);
    expect(addToken(["read"], "read")).toEqual(["read"]);
    expect(addToken(["read"], "  ")).toEqual(["read"]);
    expect(removeToken(["read", "bash", "edit"], 1)).toEqual(["read", "edit"]);
  });
  it("suggests unchosen names, prefix matches first", () => {
    expect(suggest(["read", "bash", "grep", "write", "rg"], ["read"], "r")).toEqual(["rg", "grep", "write"]);
    expect(suggest(["read", "bash"], ["read"], "")).toEqual(["bash"]);
  });
});

describe("playback", () => {
  const last = 3;
  it("plays tick by tick and stops at the end", () => {
    let s = playback({ at: 0, playing: false }, { t: "toggle", last });
    expect(s).toEqual({ at: 0, playing: true });
    s = playback(s, { t: "tick", last }); s = playback(s, { t: "tick", last });
    expect(s).toEqual({ at: 2, playing: true });
    s = playback(s, { t: "tick", last });
    expect(s).toEqual({ at: 3, playing: false });
    expect(playback(s, { t: "tick", last })).toEqual(s);
  });
  it("play from the end starts over; nothing to play with one step", () => {
    expect(playback({ at: 3, playing: false }, { t: "toggle", last })).toEqual({ at: 0, playing: true });
    expect(playback({ at: 0, playing: false }, { t: "toggle", last: 0 }).playing).toBe(false);
  });
  it("stepping or seeking pauses and clamps", () => {
    expect(playback({ at: 1, playing: true }, { t: "step", by: 1, last })).toEqual({ at: 2, playing: false });
    expect(playback({ at: 0, playing: false }, { t: "step", by: -1, last })).toEqual({ at: 0, playing: false });
    expect(playback({ at: 1, playing: true }, { t: "seek", to: 9, last })).toEqual({ at: 3, playing: false });
  });
});

describe("markdown preview blocks", () => {
  it("reads tables, quotes and rules", () => {
    const b = parse("| a | b |\n|---|---|\n| 1 | 2 |\n\n> note\n\n---", []);
    expect(b.map((x) => x.t)).toEqual(["table", "quote", "hr"]);
  });
});
