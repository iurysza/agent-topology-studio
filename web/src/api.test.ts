import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, currentApi, listProjects, projectRuns, readToken, setProject } from "./api.ts";
import type { Machine } from "./types.ts";

type Call = { url: string; method: string; token: string | null };
let calls: Call[] = [];
let answer: () => Promise<Response> = async () => new Response("{}", { status: 200 });

beforeEach(() => {
  calls = [];
  vi.stubGlobal("location", { search: "?token=t", hash: "" });
  vi.stubGlobal("fetch", (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET", token: new Headers(init.headers).get("X-Studio-Token") });
    return answer();
  });
});
afterEach(() => { vi.unstubAllGlobals(); setProject(null); answer = async () => new Response("{}", { status: 200 }); });

const machine = { id: "build", name: "build", description: "", initial: "a", states: {} } as unknown as Machine;

describe("project-scoped clients", () => {
  it("a captured client keeps its project across a switch", async () => {
    setProject("a");
    const c = currentApi();
    setProject("b");
    await c.save("build", machine, "h");
    expect(calls.at(-1)).toMatchObject({ url: "/api/p/a/workflows/build", method: "PUT", token: "t" });
    await api.project();
    expect(calls.at(-1)?.url).toBe("/api/p/b/project");
    expect(currentApi()).toBe(api);
  });
  it("setProject(null) goes back to the single project", async () => {
    setProject("a");
    setProject(null);
    await api.project();
    expect(calls.at(-1)?.url).toBe("/api/project");
  });
  it("encodes the id", async () => {
    setProject("a b");
    await api.runs("w");
    expect(calls.at(-1)?.url).toBe("/api/p/a%20b/runs?workflow=w");
  });
});

describe("listProjects", () => {
  it("returns the list for a 200", async () => {
    const body = { projects: [{ id: "x-1a2b3c4d", root: "/h/x", name: "x", workflows: 1, lastRunAt: null, source: "session" }], warnings: ["w"] };
    answer = async () => new Response(JSON.stringify(body), { status: 200 });
    expect(await listProjects()).toEqual(body);
    expect(calls.at(-1)).toMatchObject({ url: "/api/projects", token: "t" });
  });
  it.each([404, 401, 500])("returns null for %i", async (status) => {
    answer = async () => new Response(JSON.stringify({ error: "x" }), { status });
    expect(await listProjects()).toBeNull();
  });
  it("returns null when fetch rejects", async () => {
    answer = async () => { throw new TypeError("network down"); };
    expect(await listProjects()).toBeNull();
  });
  it("returns null for a 200 that is not a list", async () => {
    answer = async () => new Response("not json", { status: 200 });
    expect(await listProjects()).toBeNull();
  });
});

describe("projectRuns", () => {
  it("fetches /api/p/<id>/runs with the token, whatever project is current", async () => {
    answer = async () => new Response(JSON.stringify({ runs: [] }), { status: 200 });
    setProject("other");
    expect(await projectRuns("a b")).toEqual({ runs: [] });
    expect(calls.at(-1)).toMatchObject({ url: "/api/p/a%20b/runs", method: "GET", token: "t" });
    setProject(null);
    await projectRuns("x");
    expect(calls.at(-1)?.url).toBe("/api/p/x/runs");
  });
  it("rejects on an error status", async () => {
    answer = async () => new Response(JSON.stringify({ error: "nope" }), { status: 404 });
    await expect(projectRuns("x")).rejects.toThrow("nope");
  });
});

describe("readToken", () => {
  beforeEach(() => {
    const m = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear() });
  });
  afterEach(() => vi.unstubAllGlobals());
  it("keeps a well-formed token from the URL", () => {
    expect(readToken("?token=abc123_-")).toBe("abc123_-");
    expect(localStorage.getItem("topology-studio:token")).toBe("abc123_-");
  });
  it("ignores a malformed token so a cut link cannot poison storage", () => {
    localStorage.setItem("topology-studio:token", "good");
    expect(readToken("?token=…")).toBe("good");
    expect(readToken("?token=a b")).toBe("good");
    expect(localStorage.getItem("topology-studio:token")).toBe("good");
  });
  it("drops a stored token that is already malformed", () => {
    localStorage.setItem("topology-studio:token", "…");
    expect(readToken("?")).toBe("");
    expect(localStorage.getItem("topology-studio:token")).toBe(null);
  });
});
