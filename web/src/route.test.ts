import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { href, link, setRouteProject, splitHash, switchProject } from "./route.ts";

describe("splitHash", () => {
  it("splits the project from the route", () => {
    expect(splitHash("#/p/x-1a2b3c4d/runs?w=a")).toEqual({ project: "x-1a2b3c4d", rest: "#/runs?w=a" });
    expect(splitHash("#/p/x/")).toEqual({ project: "x", rest: "#/" });
    expect(splitHash("#/p/x")).toEqual({ project: "x", rest: "#/" });
    expect(splitHash("#/p/x/w/build")).toEqual({ project: "x", rest: "#/w/build" });
    expect(splitHash("#/p/x/roles/coder")).toEqual({ project: "x", rest: "#/roles/coder" });
  });
  it("leaves unscoped and malformed hashes alone", () => {
    expect(splitHash("#/")).toEqual({ project: null, rest: "#/" });
    expect(splitHash("")).toEqual({ project: null, rest: "" });
    expect(splitHash("#/runs?workflow=build")).toEqual({ project: null, rest: "#/runs?workflow=build" });
    expect(splitHash("#/p/")).toEqual({ project: null, rest: "#/p/" });
  });
});

// Every shape the 18 wrapped sites pass, in the form they pass it.
const WRAPPED_HASHES = [
  "#/", "#/roles", "#/runs", "/w/build", "#/w/build",
  "/roles/coder", "#/roles/coder", "#/roles/a%20b", "#/runs/r-1", "/runs?workflow=build", "/runs",
  "#/runs?workflow=build", "#/runs/r-1?at=3",
  // homepage.tsx: the last-outcome link and the recent strip, built as the code builds them
  `#/runs/${encodeURIComponent("wf_1a40 d4")}`, `#/runs?workflow=${encodeURIComponent("build/x")}`,
  // homepage.tsx: the Now rows, their Watch link and "N more"
  `#/runs/${encodeURIComponent("council-fixture-live")}`, "#/runs",
];

describe("link", () => {
  it("scopes both hash forms and keeps the form", () => {
    expect(link("#/roles", "x")).toBe("#/p/x/roles");
    expect(link("/roles", "x")).toBe("/p/x/roles");
    expect(link("#/", "x")).toBe("#/p/x/");
    expect(link("/runs?workflow=a", "x")).toBe("/p/x/runs?workflow=a");
  });
  it("is unchanged in single mode for every wrapped shape", () => {
    for (const h of WRAPPED_HASHES) expect(link(h, null)).toBe(h);
  });
  it("is idempotent and never rescopes", () => {
    for (const h of WRAPPED_HASHES) expect(link(link(h, "x"), "x")).toBe(link(h, "x"));
    expect(link("#/p/x/runs", "y")).toBe("#/p/x/runs");
    expect(link("/p/x/runs", "y")).toBe("/p/x/runs");
  });
  it("round-trips with splitHash", () => {
    for (const h of WRAPPED_HASHES.filter((s) => s.startsWith("#"))) expect(splitHash(link(h, "x"))).toEqual({ project: "x", rest: h });
  });
  it("href follows the route project", () => {
    setRouteProject("x");
    expect(href("#/runs")).toBe("#/p/x/runs");
    setRouteProject(null);
    expect(href("#/runs")).toBe("#/runs");
  });
});

// A hash link written without href() would drop the project in all projects mode. Each matching line must route
// through the helpers or be one of the known lines whose value is already scoped or must stay unscoped.
const SITE = /"#\/|`#\/|location\.hash/;
const HELPERS = ["href(", "splitHash(", "link("];
const KNOWN = [
  'className="brand" href="#/"', // the brand: the project list in all mode
  "location.hash = to;", // Discard: `to` is the stored, already scoped hash
  "runHref(r.id).slice(1)", // runHref is wrapped
  "back.href.slice(1)", // back.href is wrapped where it is made
  "setLeaving({ to: location.hash", // the leaving guard stores the full hash
  'location.hash !== "#/") history.replaceState', // the project list normalises its address
  "href={`#/p/${p.id}/`}", // project list links are built from the id
  'id === ALL ? "#/" : switchProject(', // the bar switcher: the list, or switchProject() (link() with the new id)
];

describe("hash link sites", () => {
  it("every site goes through the route helpers", () => {
    const dir = new URL(".", import.meta.url);
    const files = readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !/\.test\.ts$/.test(f) && f !== "route.ts");
    const bad: string[] = [];
    let sites = 0;
    for (const f of files) {
      readFileSync(new URL(f, dir), "utf8").split("\n").forEach((line, i) => {
        if (!SITE.test(line) || line.trimStart().startsWith("//")) return;
        sites++;
        if (!HELPERS.some((h) => line.includes(h)) && !KNOWN.some((k) => line.includes(k))) bad.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(bad).toEqual([]);
    expect(sites).toBeGreaterThanOrEqual(25);
  });
});

describe("switchProject", () => {
  it("keeps the route and swaps the project, with one /p/", () => {
    expect(switchProject("#/p/a/runs", "b")).toBe("#/p/b/runs");
    expect(switchProject("#/p/a/", "b")).toBe("#/p/b/");
    expect(switchProject("#/p/a/roles", "b")).toBe("#/p/b/roles");
    expect(switchProject("#/p/a/runs?workflow=build", "b")).toBe("#/p/b/runs?workflow=build");
    expect(switchProject("#/", "b")).toBe("#/p/b/");
  });
  it("sends one item's page to the new project's list for that tab", () => {
    expect(switchProject("#/p/a/runs/r-1?at=3", "b")).toBe("#/p/b/runs");
    expect(switchProject("#/p/a/roles/coder", "b")).toBe("#/p/b/roles");
    expect(switchProject("#/p/a/w/build", "b")).toBe("#/p/b/");
  });
});
