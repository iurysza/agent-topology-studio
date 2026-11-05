import { realpath, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as Effect from 'effect/Effect';
import { sessionRunsRoot } from '../server/session-paths.ts';
import { extractMeta, isSafeName, hashText } from './check.ts';
import { extract } from '../shared/machine.ts';
import { projectRuns } from './runs.ts';
import { readCatalog } from './catalog.ts';
import { isRoleName, roleRecord, roleCode, roleListFields } from './roles.ts';
import type { RoleName, RoleRecord } from './roles.ts';
import { ProjectPathError, StaleError, RoleError, FsError } from './errors.ts';
import { isErrno } from './narrow.ts';
import { optionalRead, list, readText, atomicWrite, removeFile, guarded } from './project-fs.ts';
import { runEdge } from './edge.ts';
import { readBranch } from './git.ts';
import type { Json } from '../shared/replay.ts';
import type { LiteralValue } from '../shared/literal.ts';
export { StaleError, ProjectPathError } from './errors.ts';

export type OpenOptions = { toolRoot?: string; runsFrom?: string };

/** What openProject resolves to. http.ts and bin/cli read it. */
export type Project = Awaited<ReturnType<typeof openProject>>;

/** A workflow as the list shows it. name and description may come from an unvalidated meta literal, as before. */
type WorkflowEntry = { id: string; name: LiteralValue; description: LiteralValue; editable: boolean; states: number };

/** The POST /api/roles body: a name, an optional body and frontmatter fields. roleName and roleCode check them. */
type NewRole = { [key: string]: Json };

const roleName = (name: Json | undefined): RoleName => {
  if (!isRoleName(name)) throw new RoleError({ message: 'Role name must use lowercase letters, digits, and hyphens, starting with a letter' });

  return name;
};

const saves = new Map<string, Promise<string>>();
export async function openProject(dir: string, { toolRoot, runsFrom }: OpenOptions = {}) {
  const root = await realpath(path.resolve(dir));
  if (!(await stat(root)).isDirectory()) throw new Error('Project must be a directory');
  if (toolRoot) {
    const tool = await realpath(toolRoot);
    if (root === tool) throw Object.assign(new Error("This is the tool's own repo"), { hint: 'try --project playground' });
    let fixtures: string | undefined; try { fixtures = await realpath(path.join(tool, 'fixtures')); } catch (e) { if (!isErrno(e) || e.code !== 'ENOENT') throw e; }
    if (fixtures && (root === fixtures || root.startsWith(fixtures + path.sep))) throw Object.assign(new Error('fixtures/ is read only'), { hint: 'try --project playground' });
  }
  const contained = (target: string, boundary: string = root): string => {
    let candidate = target;
    while (true) {
      let resolved: string;
      try { resolved = realpathSync(candidate); }
      catch (e) { if (!isErrno(e) || e.code !== 'ENOENT') throw e; candidate = path.dirname(candidate); continue; }
      const destination = path.resolve(resolved, path.relative(candidate, target));
      if (destination !== boundary && !destination.startsWith(boundary + path.sep)) throw new ProjectPathError();
      return target;
    }
  };
  const workflows = path.join(root, '.pi/workflows');
  const runsRoot = runsFrom === undefined ? root : await realpath(path.resolve(runsFrom));
  if (!(await stat(runsRoot)).isDirectory()) throw new Error('Runs source must be a directory');
  const sessions = sessionRunsRoot(runsRoot, await realpath(os.tmpdir()), process.getuid?.() ?? 'default');
  const sessionContained = (target: string) => contained(target, sessions);
  const homeSkills = path.join(os.homedir(), '.pi/agent/skills');
  const file = (name: string) => { if (!isSafeName(name)) throw new Error('Unsafe workflow name'); return contained(path.join(contained(workflows), name + '.js')); };
  const roleFile = (name: string) => { const valid = roleName(name); return contained(path.join(contained(path.join(root, '.pi/agents')), valid + '.md')); };
  const listWorkflowsEffect = () => Effect.gen(function* () {
    const result: WorkflowEntry[] = [];
    for (const entry of yield* list(yield* guarded(contained, workflows))) {
      const id = entry.replace(/\.js$/, ''); if (!entry.endsWith('.js') || !isSafeName(id)) continue;
      const code = yield* optionalRead(file(id)); if (code === null) continue;
      const machine = extract(code), meta = extractMeta(code);
      result.push({ id, name: machine?.name ?? meta?.name ?? id, description: machine?.description ?? meta?.description ?? '', editable: machine !== null, states: machine?.states && typeof machine.states === 'object' ? Object.keys(machine.states).length : 0 });
    }
    return result.sort((a, b) => a.id.localeCompare(b.id));
  });
  const listRolesEffect = () => Effect.gen(function* () {
    const dir = yield* guarded(contained, path.join(root, '.pi/agents')), roles: RoleRecord[] = [];
    for (const entry of yield* list(dir)) {
      if (!entry.endsWith('.md')) continue;
      roles.push(roleRecord(entry.slice(0, -3), yield* readText(yield* guarded(contained, path.join(dir, entry)))).role);
    }
    return roles.sort((a, b) => a.name.localeCompare(b.name));
  });
  const catalogEffect = () => Effect.gen(function* () {
    const roles = yield* listRolesEffect();
    return yield* Effect.tryPromise({
      try: () => readCatalog(root, contained, roles, homeSkills),
      catch: (cause: unknown) => cause instanceof ProjectPathError ? cause : new FsError({ op: 'catalog', path: root, cause }),
    });
  });
  const readRoleEffect = (name: string) => Effect.gen(function* () {
    const code = yield* optionalRead(roleFile(name));
    return code === null ? null : { ...roleRecord(name, code), hash: hashText(code) };
  });
  const writeRoleEffect = (name: string, frontmatter: Json | undefined, body: Json | undefined, baseHash: string | null) => Effect.gen(function* () {
    const target = roleFile(name), current = yield* optionalRead(target), hash = current === null ? null : hashText(current);
    if (baseHash !== hash) return yield* new StaleError({ baseSha256: baseHash, currentSha256: hash });
    const code = roleCode(current, frontmatter, body);
    yield* atomicWrite(target, code);
    return { ...roleRecord(name, code), hash: hashText(code) };
  });
  const createRoleEffect = ({ name, body = '', ...frontmatter }: NewRole) => Effect.gen(function* () {
    for (const key of roleListFields) { const value = frontmatter[key]; if (typeof value === 'string') frontmatter[key] = value.split(',').map(item => item.trim()); }
    const exists = () => new RoleError({ message: `Role \`${name}\` already exists` });
    const valid = roleName(name);
    if ((yield* optionalRead(roleFile(valid))) !== null) return yield* exists();
    return yield* writeRoleEffect(valid, frontmatter, body, null).pipe(Effect.catchTag('StaleError', () => Effect.fail(exists())));
  });
  const readScriptEffect = (name: string) => Effect.gen(function* () {
    const code = yield* optionalRead(file(name));
    return { code, sha256: code === null ? null : hashText(code) };
  });
  const writeScriptEffect = (name: string, code: string, baseSha256: string | null) => Effect.gen(function* () {
    const current = yield* optionalRead(file(name)), sha = current === null ? null : hashText(current);
    if (baseSha256 !== sha) return yield* new StaleError({ baseSha256, currentSha256: sha });
    // External editors are not locked; concurrent studio saves are serialized.
    yield* atomicWrite(file(name), code); return hashText(code);
  });
  const deleteScriptEffect = (name: string) => Effect.gen(function* () { return yield* removeFile(file(name)); });
  return {
    root,
    name: path.basename(root),
    branch: async () => runEdge(readBranch(root)),
    ...projectRuns(workflows, contained, { sessions, sessionContained }),
    listWorkflows: async () => runEdge(listWorkflowsEffect()),
    listRoles: async () => runEdge(listRolesEffect()),
    catalog: async () => runEdge(catalogEffect()),
    readRole: async (name: string) => runEdge(readRoleEffect(name)),
    writeRole: async (name: string, frontmatter: Json | undefined, body: Json | undefined, baseHash: string | null) => runEdge(writeRoleEffect(name, frontmatter, body, baseHash)),
    createRole: async (input: NewRole) => runEdge(createRoleEffect(input)),
    readScript: async (name: string) => runEdge(readScriptEffect(name)),
    async writeScript(name: string, code: string, baseSha256: string | null): Promise<string> {
      const target = file(name);
      const save = (saves.get(target) ?? Promise.resolve()).catch(() => {}).then(() => runEdge(writeScriptEffect(name, code, baseSha256)));
      saves.set(target, save);
      try { return await save; } finally { if (saves.get(target) === save) saves.delete(target); }
    },
    deleteScript: async (name: string) => runEdge(deleteScriptEffect(name)),
    scriptPath: file,
  };
}
