// Finds every project on this machine that has .pi/workflows/*.js. See ADR-0004 in ai-artifacts/docs/adr.
import * as Effect from 'effect/Effect';
import * as Result from 'effect/Result';
import { realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { sessionRunsRoot } from '../server/session-paths.ts';
import { isSafeName } from './check.ts';
import { ProjectFs } from './services.ts';
import { attempt, list, optionalRead } from './project-fs.ts';
import { runEdge } from './edge.ts';
import { openProject as defaultOpenProject } from './project.ts';
import { messageOf } from './narrow.ts';
import type { Json, JsonObject } from '../shared/replay.ts';

type ProjectSource = 'session' | 'config' | 'cli';

type ProjectEntry = { id: string; root: string; name: string; workflows: number; lastRunAt: string | null; source: ProjectSource };

export type ProjectList = { projects: ProjectEntry[]; warnings: string[] };

export type DiscoverOptions = { home: string; sessionsDir: string; configFile: string; extra?: string[]; tmpDir: string; uid: string | number; toolRoot?: string };

type Candidate = { path: string; source: ProjectSource; given?: string };

export type Checked = { root: string; workflows: number } | { reason: string };

type FixedPaths = { realHome: string; tool: string | null; fixtures: string | null };

type RootOptions = { home: string; toolRoot?: string };

/** One discovery. at is null while it runs. */
type Discovery = { at: number | null; promise: Promise<ProjectList> };

/** What the default openProject resolves to. */
type OpenedProject = Awaited<ReturnType<typeof defaultOpenProject>>;

type Opener<P> = (root: string, options: { toolRoot?: string }) => Promise<P>;

type RegistryOptions<P> = Partial<DiscoverOptions> & {
  now?: () => number;
  openProject?: Opener<P>;
  discover?: (options: DiscoverOptions) => Promise<ProjectList>;
  check?: (root: string) => Promise<Checked>;
};

/** A parsed JSON object, so `value?.key` reads give undefined for every other JSON value, as before. */
const isJsonObject = (value: Json): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

const journalSuffix = '.workflow.jsonl';
const headerBytes = 4096;
const cacheMs = 5000;

export const projectId = (root: string): string => {
  const slug = path.basename(root).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+/, '').slice(0, 40) || 'project';
  return `${slug}-${createHash('sha256').update(root).digest('hex').slice(0, 8)}`;
};

export const isProjectId = (id: string): boolean => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,39}-[0-9a-f]{8}$/.test(id);

const inside = (target: string, boundary: string) => target === boundary || target.startsWith(boundary + path.sep);

/** Gives null on any failure. */
const resolveReal = (file: string) => Effect.orElseSucceed(attempt('realpath', file, () => realpath(file)), () => null);

/** The real path of file when it stays inside boundary, else null. */
const resolveInside = (file: string, boundary: string) => Effect.map(resolveReal(file), real => real !== null && inside(real, boundary) ? real : null);

/** The cwd from the first line of the oldest session file in one session folder, or null. */
const sessionCwd = (folder: string, realSessions: string): Effect.Effect<string | null, never, ProjectFs> => Effect.orElseSucceed(Effect.gen(function* () {
  const fs = yield* ProjectFs;
  // Containment before metadata: a session folder that resolves outside the sessions folder is never listed.
  const real = yield* resolveInside(folder, realSessions);
  if (real === null) return null;
  const first = (yield* attempt('readdir', real, () => fs.readdir(real))).filter(name => name.endsWith('.jsonl')).sort()[0];
  if (!first) return null;
  const file = path.join(real, first);
  // A session file that resolves outside the sessions folder is skipped.
  if ((yield* resolveInside(file, realSessions)) === null) return null;
  const text = yield* Effect.acquireUseRelease(
    attempt('open', file, () => fs.open(file, 'r')),
    handle => attempt('read', file, async () => {
      const buffer = Buffer.alloc(headerBytes);
      const { bytesRead } = await handle.read(buffer, 0, headerBytes, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    }),
    handle => Effect.ignore(attempt('close', file, () => handle.close())),
  );
  const header = yield* Effect.try({ try: (): Json => JSON.parse(text.split('\n', 1)[0]), catch: cause => cause });
  const cwd = isJsonObject(header) ? header.cwd : undefined;
  return typeof cwd === 'string' ? cwd : null;
}), () => null);

const configCandidates = (configFile: string, home: string): Effect.Effect<{ paths: string[]; warnings: string[] }, never, ProjectFs> => Effect.gen(function* () {
  const text = yield* Effect.result(optionalRead(configFile));
  if (Result.isFailure(text)) return { paths: [], warnings: [`projects.json: ${messageOf(text.failure.cause) ?? 'cannot read'}`] };
  if (text.success === null) return { paths: [], warnings: [] };
  let parsed: Json;
  try { parsed = JSON.parse(text.success); }
  catch (error) { return { paths: [], warnings: [`projects.json: ${messageOf(error)}`] }; }
  const projects = isJsonObject(parsed) ? parsed.projects : undefined;
  if (!Array.isArray(projects) || !projects.every(item => typeof item === 'string')) return { paths: [], warnings: ['projects.json: expected { "projects": ["/path", ...] }'] };
  const expand = (item: string) => item === '~' ? home : item.startsWith('~/') ? path.join(home, item.slice(2)) : item;
  return { paths: projects.map(expand), warnings: [] };
});

/** The D2 filter. Gives the real root and the workflow count, or the first failed check. */
const checkCandidate = (candidate: string, { realHome, tool, fixtures }: FixedPaths): Effect.Effect<Checked, never, ProjectFs> => Effect.orElseSucceed(Effect.gen(function* () {
  const fs = yield* ProjectFs;
  if (!path.isAbsolute(candidate)) return { reason: 'not an absolute path' };
  const root = yield* resolveReal(candidate);
  if (root === null) return { reason: 'not found' };
  // Containment before metadata: nothing outside home is statted.
  if (!inside(root, realHome)) return { reason: 'outside your home folder' };
  if (!(yield* attempt('stat', root, () => fs.stat(root))).isDirectory()) return { reason: 'not a directory' };
  if (tool && root === tool) return { reason: "the studio's own repo" };
  if (fixtures && inside(root, fixtures)) return { reason: "inside the studio's fixtures" };
  const workflows = yield* resolveReal(path.join(root, '.pi/workflows'));
  if (workflows === null) return { reason: 'no .pi/workflows/*.js' };
  if (!inside(workflows, root)) return { reason: '.pi/workflows points outside the project' };
  const count = (yield* list(workflows)).filter(entry => entry.endsWith('.js') && isSafeName(entry.slice(0, -3))).length;
  return count > 0 ? { root, workflows: count } : { reason: 'no .pi/workflows/*.js' };
}), () => ({ reason: 'cannot read' }));

/** Newest mtime in ms of any journal in dir that resolves inside boundary, or 0. */
const newestJournal = (dir: string, boundary: string): Effect.Effect<number, never, ProjectFs> => Effect.orElseSucceed(Effect.gen(function* () {
  const fs = yield* ProjectFs;
  let newest = 0;
  for (const name of yield* attempt('readdir', dir, () => fs.readdir(dir))) {
    if (!name.endsWith(journalSuffix)) continue;
    const file = yield* resolveInside(path.join(dir, name), boundary);
    if (file === null) continue;
    const info = yield* Effect.orElseSucceed(attempt('stat', file, () => fs.stat(file)), () => null);
    if (info?.isFile() && info.mtimeMs > newest) newest = info.mtimeMs;
  }
  return newest;
}), () => 0);

/** D7: the newest journal mtime in the project folder or the session tasks folders. */
const lastRunAt = (root: string, realTmp: string | null, uid: string | number): Effect.Effect<string | null, never, ProjectFs> => Effect.gen(function* () {
  let newest = yield* newestJournal(path.join(root, '.pi/workflows'), root);
  // root and realTmp are real, so expected is the canonical boundary. A runs folder that resolves anywhere else, for example a symlink out, is skipped.
  const expected = realTmp === null ? null : sessionRunsRoot(root, realTmp, uid);
  if (expected !== null && (yield* resolveInside(expected, expected)) === expected) {
    for (const session of yield* Effect.orElseSucceed(list(expected), () => [])) {
      // A tasks folder that resolves outside this project's session runs folder is skipped.
      const tasks = yield* resolveInside(path.join(expected, session, 'tasks'), expected);
      if (tasks !== null) newest = Math.max(newest, yield* newestJournal(tasks, expected));
    }
  }
  return newest > 0 ? new Date(newest).toISOString() : null;
});

const byLastRun = (a: ProjectEntry, b: ProjectEntry) => {
  if (a.lastRunAt !== b.lastRunAt) {
    if (a.lastRunAt === null) return 1;
    if (b.lastRunAt === null) return -1;
    return a.lastRunAt < b.lastRunAt ? 1 : -1;
  }
  return a.name.localeCompare(b.name);
};

/** The fixed real paths the D2 filter compares against. Fails with a warning line when home does not resolve. */
const fixedPaths = ({ home, toolRoot }: RootOptions): Effect.Effect<FixedPaths | { warning: string }, never, ProjectFs> => Effect.gen(function* () {
  const homeResult = yield* Effect.result(attempt('realpath', home, () => realpath(home)));
  if (Result.isFailure(homeResult)) return { warning: `home: ${messageOf(homeResult.failure.cause) ?? 'cannot resolve'}` };
  const tool = toolRoot ? yield* resolveReal(toolRoot) : null;
  const fixtures = tool ? yield* resolveReal(path.join(tool, 'fixtures')) : null;
  return { realHome: homeResult.success, tool, fixtures };
});

/** Runs the D2 filter again on one root, as open() does before it trusts a discovered root. */
export const checkRoot = (root: string, options: RootOptions): Effect.Effect<Checked, never, ProjectFs> => Effect.gen(function* () {
  const fixed = yield* fixedPaths(options);
  return 'warning' in fixed ? { reason: fixed.warning } : yield* checkCandidate(root, fixed);
});

/** idOf exists so tests can force an id collision. */
export const discoverProjects = ({ home, sessionsDir, configFile, extra = [], tmpDir, uid, toolRoot, idOf = projectId }: DiscoverOptions & { idOf?: (root: string) => string }): Effect.Effect<ProjectList, never, ProjectFs> => Effect.gen(function* () {
  const fixed = yield* fixedPaths({ home, toolRoot });
  if ('warning' in fixed) return { projects: [], warnings: [fixed.warning] };
  const realTmp = yield* resolveReal(tmpDir);
  const realSessions = yield* resolveReal(sessionsDir);

  const folders = realSessions === null ? [] : yield* Effect.orElseSucceed(list(realSessions), () => []);
  // folders is empty when realSessions is null, so the callback never runs then.
  const cwds = realSessions === null ? [] : yield* Effect.forEach(folders, folder => sessionCwd(path.join(sessionsDir, folder), realSessions), { concurrency: 16 });
  const config = yield* configCandidates(configFile, home);
  const candidates: Candidate[] = [
    ...extra.map((dir): Candidate => ({ path: path.resolve(dir), source: 'cli', given: dir })),
    ...config.paths.map((dir): Candidate => ({ path: dir, source: 'config' })),
    ...cwds.filter(cwd => cwd !== null).map((cwd): Candidate => ({ path: cwd, source: 'session' })),
  ];

  const warnings = [...config.warnings];
  const checked = yield* Effect.forEach(candidates, candidate => checkCandidate(candidate.path, fixed), { concurrency: 16 });
  const roots = new Map<string, { root: string; workflows: number; source: ProjectSource }>();
  checked.forEach((result, index) => {
    const candidate = candidates[index];
    if ('reason' in result) {
      if (candidate.source === 'cli') warnings.push(`--project ${candidate.given}: ${result.reason}`);
      return;
    }
    if (!roots.has(result.root)) roots.set(result.root, { ...result, source: candidate.source });
  });

  // Two roots with the same id are both dropped: an id must never be able to mean either root.
  const byId = new Map<string, string[]>();
  for (const root of roots.keys()) byId.set(idOf(root), [...(byId.get(idOf(root)) ?? []), root]);
  for (const [id, clashing] of byId) {
    if (clashing.length < 2) continue;
    warnings.push(`id ${id} is shared by ${clashing.join(' and ')}; both are left out`);
    for (const root of clashing) roots.delete(root);
  }
  const found = [...roots.values()];
  const runs = yield* Effect.forEach(found, entry => lastRunAt(entry.root, realTmp, uid), { concurrency: 16 });
  const counts = new Map<string, number>();
  for (const entry of found) counts.set(path.basename(entry.root), (counts.get(path.basename(entry.root)) ?? 0) + 1);
  const projects = found.map((entry, index) => {
    const base = path.basename(entry.root);
    const name = (counts.get(base) ?? 0) > 1 ? `${path.basename(path.dirname(entry.root))}/${base}` : base;
    return { id: idOf(entry.root), root: entry.root, name, workflows: entry.workflows, lastRunAt: runs[index], source: entry.source };
  });
  return { projects: projects.sort(byLastRun), warnings };
});

/**
 * The registry the server uses in all projects mode. list() is cached for 5 seconds after discovery settles; open() never rejects.
 * P is what a test's own openProject resolves to; it defaults to the real project.
 */
export function createRegistry<P = OpenedProject>(options: RegistryOptions<P> = {}) {
  const home = options.home ?? os.homedir();
  const discoverOptions: DiscoverOptions = {
    home,
    sessionsDir: options.sessionsDir ?? path.join(home, '.pi/agent/sessions'),
    configFile: options.configFile ?? path.join(home, '.config/topology-studio/projects.json'),
    extra: options.extra ?? [],
    tmpDir: options.tmpDir ?? os.tmpdir(),
    uid: options.uid ?? process.getuid?.() ?? 'default',
    toolRoot: options.toolRoot,
  };
  const now = options.now ?? Date.now;
  const open: Opener<P | OpenedProject> = options.openProject ?? defaultOpenProject;
  const discover = options.discover ?? ((input: DiscoverOptions) => runEdge(discoverProjects(input)));
  const check = options.check ?? ((root: string) => runEdge(checkRoot(root, discoverOptions)));
  /** at is null while discovery runs, so a slow discovery is never overlapped by a second one. */
  let cached: Discovery | null = null;
  /** Keyed by id and root, so a refresh that maps an id to another root never serves the old one. */
  const opened = new Map<string, Promise<P | OpenedProject | null>>();
  const keyOf = (entry: { id: string; root: string }) => `${entry.id}\n${entry.root}`;

  const listProjects = (): Promise<ProjectList> => {
    if (cached && (cached.at === null || now() - cached.at < cacheMs)) return cached.promise;
    const current: Discovery = {
      at: null,
      promise: discover(discoverOptions).then(result => {
        current.at = now();
        const keys = new Set(result.projects.map(keyOf));
        for (const key of opened.keys()) if (!keys.has(key)) opened.delete(key);
        return result;
      }, (cause: unknown) => {
        if (cached === current) cached = null;
        throw cause;
      }),
    };
    cached = current;
    return current.promise;
  };

  const resolve = async (id: string): Promise<ProjectEntry | null> => (await listProjects()).projects.find(project => project.id === id) ?? null;

  return {
    list: listProjects,
    resolve,
    async open(id: string): Promise<P | OpenedProject | null> {
      const entry = await resolve(id);
      if (!entry) return null;
      const key = keyOf(entry);
      const existing = opened.get(key);
      if (existing) return existing;
      // Before the first open, the root may have been swapped since discovery, for example for a symlink out of home. Check it again.
      const checked: Checked = await check(entry.root).catch(() => ({ reason: 'cannot read' }));
      const reason = 'reason' in checked ? checked.reason : checked.root === entry.root ? null : `now resolves to ${checked.root}`;
      if (reason !== null) {
        opened.delete(key);
        const warning = `project ${entry.root}: ${reason}`;
        const current = await listProjects();
        if (!current.warnings.includes(warning)) { current.warnings.push(warning); console.error(warning); }
        return null;
      }
      const again = opened.get(key);
      if (again) return again;
      const pending: Promise<P | OpenedProject | null> = open(entry.root, { toolRoot: discoverOptions.toolRoot }).catch((cause: unknown) => {
        if (opened.get(key) === pending) opened.delete(key);
        console.error(`Could not open project ${entry.root}: ${messageOf(cause) ?? cause}`);
        return null;
      });
      opened.set(key, pending);
      return pending;
    },
  };
}
