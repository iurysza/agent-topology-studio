// The server API (spec section 4). With VITE_MOCK=1 the same calls run against an in-memory project,
// compiled with the shared compiler, so the UI can be built and shot without a server.
import { compile, templateMachine } from "../../shared/machine.ts";
import type { Loaded, Machine, Project, ProjectEntry, Role, RoleFile } from "./types.ts";
import { validate } from "./validate.ts";
import { build, plan, roleBodies, roles } from "./mock/machines.ts";
import type { Run, RunDetail } from "./runs.ts";
import { fixtureList, fixtureRuns } from "./runs-fixture.ts";

export class ApiError extends Error {
  constructor(public status: number, public body: { error?: string; problems?: string[] }) {
    super(body.error ?? body.problems?.join("\n") ?? `HTTP ${status}`);
  }
}

// The token arrives once in the URL; it is kept for this origin so reloads work.
// Only a well-formed token is kept: a copied link cut short ("token=…") would otherwise poison storage, and fetch
// rejects any header outside ISO-8859-1 before the request leaves the page.
const TOKEN = /^[A-Za-z0-9_-]+$/;
export function readToken(search = location.search): string {
  const raw = new URLSearchParams(search).get("token");
  const t = raw !== null && TOKEN.test(raw) ? raw : null;
  try {
    if (t !== null) { localStorage.setItem("topology-studio:token", t); return t; }
    const kept = localStorage.getItem("topology-studio:token") ?? "";
    if (kept !== "" && !TOKEN.test(kept)) { localStorage.removeItem("topology-studio:token"); return ""; }
    return kept;
  } catch { return t ?? ""; }
}

async function request<T>(base: string, path: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(`${base}${path}`, {
    method, headers: { "X-Studio-Token": readToken(), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, out);
  return out as T;
}

export interface Api {
  project(): Promise<Project>;
  workflow(id: string): Promise<Loaded>;
  save(id: string, machine: Machine, hash: string): Promise<{ code: string; hash: string; warnings: string[] }>;
  create(id: string): Promise<Loaded>;
  compile(machine: Machine): Promise<{ code: string; problems: string[]; warnings: string[] }>;
  remove(id: string): Promise<void>;
  role(name: string): Promise<RoleFile>;
  saveRole(name: string, frontmatter: RoleFields, body: string, baseHash: string): Promise<RoleFile>;
  createRole(r: { name: string; description?: string; color?: string; model?: string; body?: string }): Promise<RoleFile>;
  runs(workflow?: string): Promise<{ runs: Run[] }>;
  run(id: string): Promise<RunDetail>;
}
/** What a role's page writes back: every frontmatter field it shows. `null` removes the line. */
export type RoleFields = { description: string | null; color: string | null; model: string | null; thinking: string | null; tools: string[] | null; skills: string[] | null };

/** A client bound to one API base: "/api" in single mode, "/api/p/<id>" for a project in all projects mode. */
function client(base: string): Api {
  const http = <T,>(path: string, method?: string, body?: unknown) => request<T>(base, path, method, body);
  return {
    project: () => http("/project"),
    workflow: (id) => http(`/workflows/${encodeURIComponent(id)}`),
    save: (id, machine, hash) => http(`/workflows/${encodeURIComponent(id)}`, "PUT", { machine, hash }),
    create: (id) => http("/workflows", "POST", { id }),
    compile: (machine) => http("/compile", "POST", { machine }),
    remove: (id) => http(`/workflows/${encodeURIComponent(id)}`, "DELETE"),
    role: (name) => http(`/roles/${encodeURIComponent(name)}`),
    saveRole: (name, frontmatter, body, baseHash) => http(`/roles/${encodeURIComponent(name)}`, "PUT", { frontmatter, body, baseHash }),
    createRole: (r) => http("/roles", "POST", r),
    runs: (workflow) => http(`/runs${workflow ? `?workflow=${encodeURIComponent(workflow)}` : ""}`),
    run: (id) => http(`/runs/${encodeURIComponent(id)}`),
  };
}

function mockApi(): Api {
  const files = new Map<string, Machine>([["build", build], ["plan", plan]]);
  const hashOf = (code: string) => { let h = 0; for (let i = 0; i < code.length; i++) h = (h * 31 + code.charCodeAt(i)) | 0; return (h >>> 0).toString(16); };
  const loaded = (m: Machine): Loaded => { const code = compile(m); return { machine: structuredClone(m), code, hash: hashOf(code), ...validate(m, roles) }; };
  const roleFiles = new Map<string, RoleFile>(roles.map((r) => [r.name, { role: r, body: roleBodies[r.name] ?? "", hash: hashOf(r.name) }]));
  const wait = <T,>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 60));
  return {
    project: () => wait({
      dir: "~/code/sample-project/playground",
      name: "playground",
      branch: "main",
      roles,
      workflows: [
        ...[...files.values()].map((m) => ({ id: m.id, name: m.name, description: m.description, editable: true, states: Object.keys(m.states).length, machine: m })),
        { id: "triage", name: "triage", description: "Hand-written: sorts incoming issues by area.", editable: false },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    }),
    workflow: async (id) => { const m = files.get(id); if (!m) throw new ApiError(404, { error: `No workflow ${id}` }); return wait(loaded(m)); },
    save: async (id, machine, hash) => {
      const cur = files.get(id); if (cur && loaded(cur).hash !== hash) throw new ApiError(409, { error: "Changed on disk" });
      const { problems, warnings } = validate(machine, roles);
      if (problems.length) throw new ApiError(422, { problems });
      files.set(id, structuredClone(machine)); const l = loaded(machine);
      return wait({ code: l.code, hash: l.hash, warnings });
    },
    create: async (id) => { if (files.has(id)) throw new ApiError(409, { error: `${id} exists` }); const m = templateMachine(id) as Machine; files.set(id, m); return wait(loaded(m)); },
    compile: async (machine) => wait({ code: compile(machine), ...validate(machine, roles) }),
    remove: async (id) => { files.delete(id); return wait(undefined); },
    role: async (name) => { const r = roleFiles.get(name); if (!r) throw new ApiError(404, { error: "Role not found" }); return wait(structuredClone(r)); },
    saveRole: async (name, fm, body, baseHash) => {
      const cur = roleFiles.get(name); if (!cur) throw new ApiError(404, { error: "Role not found" });
      if (cur.hash !== baseHash) throw new ApiError(409, { error: "Changed on disk" });
      const role: Role = { ...cur.role }; for (const [k, v] of Object.entries(fm)) (role as unknown as Record<string, unknown>)[k] = v ?? (k === "tools" || k === "skills" ? [] : null);
      const next = { role, body, hash: hashOf(JSON.stringify(role) + body) };
      roleFiles.set(name, next); const i = roles.findIndex((r) => r.name === name); roles[i] = role;
      return wait(structuredClone(next));
    },
    createRole: async ({ name, body = "", ...fm }) => {
      if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new ApiError(422, { error: "Role name must use lowercase letters, digits, and hyphens, starting with a letter" });
      if (roleFiles.has(name)) throw new ApiError(422, { error: `Role \`${name}\` already exists` });
      const role: Role = { name, description: fm.description || null, color: fm.color || null, model: fm.model || null, thinking: null, tools: [], skills: [] };
      const r = { role, body, hash: hashOf(name + body) }; roleFiles.set(name, r); roles.push(role); roles.sort((a, b) => a.name.localeCompare(b.name));
      return wait(structuredClone(r));
    },
    runs: async (workflow) => wait({ runs: fixtureList().filter((r) => !workflow || r.workflow === workflow) }),
    run: async (id) => { const r = fixtureRuns.find((x) => x.id === id); if (!r) throw new ApiError(404, { error: "Run not found" }); return wait(structuredClone(r)); },
  };
}

/** Runs, with the dev fixture standing in while the server has no /api/runs. `fixture` says which one answered. */
export async function loadRuns(workflow?: string): Promise<{ runs: Run[]; fixture: boolean }> {
  try { return { ...(await api.runs(workflow)), fixture: mocked }; }
  catch (e) { if (!(import.meta.env.DEV && e instanceof ApiError && e.status === 404)) throw e; return { runs: fixtureList().filter((r) => !workflow || r.workflow === workflow), fixture: true }; }
}
export async function loadRun(id: string): Promise<{ run: RunDetail; fixture: boolean }> {
  try { return { run: await api.run(id), fixture: mocked }; }
  catch (e) {
    const f = fixtureRuns.find((r) => r.id === id);
    if (!(import.meta.env.DEV && e instanceof ApiError && e.status === 404 && f)) throw e;
    return { run: structuredClone(f), fixture: true };
  }
}

/** What a role may name in tools and skills. Falls back to Pi's built-in tools and no skills when the server has no catalog. */
export type Catalog = { tools: string[]; skills: string[] };
export const FALLBACK_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "codemode", "web_search", "fetch_content", "Agent", "SubagentWorkflow"];
let catalog: Promise<Catalog> | null = null;
export function loadCatalog(): Promise<Catalog> {
  const fallback: Catalog = { tools: FALLBACK_TOOLS, skills: [] };
  if (mocked) return Promise.resolve(fallback);
  return (catalog ??= request<Partial<Catalog>>(base, "/catalog")
    .then((c) => ({ tools: Array.isArray(c.tools) && c.tools.length ? c.tools : FALLBACK_TOOLS, skills: Array.isArray(c.skills) ? c.skills : [] }))
    .catch(() => { catalog = null; return fallback; }));
}

/** The project root, fetched once (main.tsx starts it) and shared by every page that shows a file path. */
let dir: Promise<string> | null = null;
export function loadDir(): Promise<string> {
  return (dir ??= api.project().then((p) => p.dir ?? "").catch(() => { dir = null; return ""; }));
}

export const mocked = import.meta.env.VITE_MOCK === "1";
const mock = mocked ? mockApi() : null;
let base = "/api";
/** The client for the current project. A live binding: importers see the new client after setProject(). Read-only pages use it. */
export let api: Api = mock ?? client(base);
/** Pages that write capture this at mount, so a save in flight keeps its project after a switch. */
export const currentApi = () => api;

/** Points the API at a project (all projects mode) or back at the single project (null). Clears the per-project caches. */
export function setProject(id: string | null) {
  base = id ? `/api/p/${encodeURIComponent(id)}` : "/api";
  api = mock ?? client(base);
  catalog = null; dir = null;
}

/** One project's runs in all projects mode, fetched from /api/p/<id>/runs with the token, whatever project is current. */
export function projectRuns(id: string): Promise<{ runs: Run[] }> {
  return mock ? mock.runs() : request(`/api/p/${encodeURIComponent(id)}`, "/runs");
}

const MOCK_PROJECTS: ProjectEntry[] = [
  { id: "playground-1a2b3c4d", root: "~/code/sample-project/playground", name: "playground", workflows: 3, lastRunAt: new Date(Date.now() - 6e4).toISOString(), source: "session" },
  { id: "machine-mvp-5e6f7a8b", root: "~/code/sample-project/machine-mvp", name: "machine-mvp", workflows: 3, lastRunAt: new Date(Date.now() - 864e5).toISOString(), source: "session" },
  { id: "notes-9c0d1e2f", root: "~/code/notes", name: "notes", workflows: 1, lastRunAt: null, source: "config" },
];

/** The project list, which is also the mode check: only a 200 means all projects mode. Anything else, a network error included, is null (single mode). Never throws. */
export async function listProjects(): Promise<{ projects: ProjectEntry[]; warnings: string[] } | null> {
  // VITE_MOCK_ALL=1 lists three fake projects; VITE_MOCK_ALL=empty lists none, to see the empty state.
  if (mocked) return import.meta.env.VITE_MOCK_ALL === "1" ? { projects: structuredClone(MOCK_PROJECTS), warnings: [] }
    : import.meta.env.VITE_MOCK_ALL === "empty" ? { projects: [], warnings: [] } : null;
  try {
    const r = await fetch("/api/projects", { headers: { "X-Studio-Token": readToken() } });
    if (r.status !== 200) return null;
    const out = await r.json() as { projects?: unknown; warnings?: unknown };
    if (!Array.isArray(out.projects)) return null;
    return { projects: out.projects as ProjectEntry[], warnings: Array.isArray(out.warnings) ? out.warnings as string[] : [] };
  } catch { return null; }
}

