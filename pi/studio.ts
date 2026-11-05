// Pi extension factory for /studio. A thin shell over bin/instances.ts, found relative to this file (C4).
// Options are test seams: dir, entry, env, extraArgs, openUrl, port, settingsPath, timeoutMs. pi/extension.ts calls it with none.
// No Pi package imports: the shapes below are local types only, so Pi stays a host, not a dependency (decisions.md D6).
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { allProjectsUrl, findInstance, listInstances, openUrl as defaultOpenUrl, startInstance, stopInstance } from '../bin/instances.ts';
import { messageOf } from '../server/narrow.ts';

export type Level = 'info' | 'warning' | 'error';

export type Ctx = { cwd: string; hasUI?: boolean; ui: { notify: (message: string, level?: Level) => void; select?: (title: string, options: string[]) => Promise<string | undefined> } };

export type Command = { description: string; getArgumentCompletions?: (prefix: string) => { value: string; label: string }[] | null; handler: (args: string, ctx: Ctx) => Promise<void> };

// Method syntax on purpose, so handlers with their own event type, such as collectMenu, stay assignable under
// strictFunctionTypes. The event type is a method type parameter rather than `unknown`, because `unknown`
// parameters and returns have a zero lint budget in pi/ (decisions.md D17). A `void` return accepts any handler.
export type Pi = {
  registerCommand(name: string, command: Command): void;
  on?<Event>(event: string, handler: (event: Event, ctx: Ctx) => void): void;
  events?: { on<Event>(event: string, handler: (event: Event, ctx: Ctx) => void): void };
};

const subcommands = ['open', 'stop', 'pick', 'all'];
// Keys taken by the fixed menu items, including `a` for the all-projects view (decisions.md D9, D10).
const reservedKeys = new Set(['o', 'p', 'x', 'a']);

type Project = { key: string; label: string; path: string };

type StudioArgs = { kind: 'ensure'; dir: string } | { kind: 'open' | 'stop' | 'pick' | 'all' } | { kind: 'unknown'; arg: string };

export type StudioOptions = { dir?: string; entry?: string; env?: NodeJS.ProcessEnv; extraArgs?: string[]; openUrl?: (url: string) => Promise<void> | void; port?: number; settingsPath?: string; timeoutMs?: number };

type MenuItem = { key: string; label: string; command: { name: string; args?: string } };

type MenuGroup = { id: string; key: string; label: string; items: MenuItem[] };

type MenuData = { version?: number; add?: (group: MenuGroup) => void };

type PickOption = { path: string; label: string };

type RegistryOptions = { dir?: string };

type StopOptions = RegistryOptions & { timeoutMs?: number };

type StartOptions = StopOptions & { port: number; entry?: string; extraArgs?: string[] };

const expandHome = (value: string, home: string): string => value === '~' ? home : value.startsWith('~/') ? path.join(home, value.slice(2)) : value;

export function defaultSettingsPath(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  return path.join(env.PI_CODING_AGENT_DIR || path.join(home, '.pi/agent'), 'settings.json');
}

// Reads topologyStudio.projects from Pi settings. Synchronous because Leader Key collects menus synchronously.
// Invalid entries are dropped; a missing or unreadable file gives []. Paths come back absolute.
export function readProjects(settingsPath: string = defaultSettingsPath(), home: string = os.homedir()): Project[] {
  let entries: unknown;
  try { entries = JSON.parse(readFileSync(settingsPath, 'utf8'))?.topologyStudio?.projects; } catch { return []; }
  if (!Array.isArray(entries)) return [];
  const seen = new Set<string>(), projects: Project[] = [];
  for (const entry of entries) {
    const { key, label, path: target } = entry ?? {};
    if (typeof key !== 'string' || !/^[a-z]$/.test(key) || reservedKeys.has(key) || seen.has(key)) continue;
    if (typeof label !== 'string' || label.trim() === '') continue;
    if (typeof target !== 'string' || target.trim() === '' || /[\r\n]/.test(target)) continue;
    seen.add(key);
    projects.push({ key, label: label.trim(), path: path.resolve(expandHome(target.trim(), home)) });
  }
  return projects;
}

const realOrResolved = (dir: string): string => { try { return realpathSync(dir); } catch { return path.resolve(dir); } };

// Parses /studio arguments (decisions.md D12): empty, a subcommand word, a path, or an error.
export function parseStudioArgs(args: string | undefined, cwd: string, home: string = os.homedir()): StudioArgs {
  const arg = (args ?? '').trim();
  if (arg === '') return { kind: 'ensure', dir: cwd };
  if (arg === 'open' || arg === 'stop' || arg === 'pick' || arg === 'all') return { kind: arg };
  if (arg.includes('/') || arg.startsWith('~') || arg.startsWith('.')) {
    return { kind: 'ensure', dir: path.resolve(cwd, expandHome(arg, home)) };
  }
  return { kind: 'unknown', arg };
}

export function createStudioExtension(options: StudioOptions = {}): (pi: Pi) => void {
  const open = options.openUrl ?? defaultOpenUrl;
  const envPort = Number(process.env.TOPOLOGY_STUDIO_PORT);
  const port = options.port ?? (Number.isInteger(envPort) && envPort >= 0 && envPort <= 65535 ? envPort : 0);
  // Only pass what the caller set, so instances.ts keeps its own defaults.
  const registry: RegistryOptions = {};
  if (options.dir !== undefined) registry.dir = options.dir;
  const stopOptions: StopOptions = { ...registry };
  if (options.timeoutMs !== undefined) stopOptions.timeoutMs = options.timeoutMs;
  const startOptions: StartOptions = { ...stopOptions, port };
  if (options.entry !== undefined) startOptions.entry = options.entry;
  if (options.extraArgs !== undefined) startOptions.extraArgs = options.extraArgs;

  async function ensure(dir: string, ctx: Ctx): Promise<void> {
    if (!existsSync(path.join(dir, '.pi/workflows'))) {
      ctx.ui.notify(`No .pi/workflows in ${dir}. The studio opens with an empty list. Create a workflow in the studio, or use /studio pick for another project.`, 'warning');
    }
    ctx.ui.notify(`Starting Topology studio for ${path.basename(dir)}…`, 'info');
    // Awaited on purpose. An installed copy times out after 30 s, a source checkout after 300 s (decisions.md D13).
    const { record, reused } = await startInstance(dir, startOptions);
    await open(record.url);
    ctx.ui.notify(`Topology studio: ${record.url}${reused ? ' (already running)' : ''}`, 'info');
  }

  // Starts or reuses the all-projects view (plan.md S5). A fresh server lists and preselects this cwd when it has workflows.
  async function ensureAll(ctx: Ctx): Promise<void> {
    ctx.ui.notify('Starting Topology studio for all projects…', 'info');
    const { record, reused } = await startInstance(ctx.cwd, { ...startOptions, all: true, ...(options.env === undefined ? {} : { env: options.env }) });
    const { url, warning } = await allProjectsUrl(record, ctx.cwd);
    if (warning !== null) ctx.ui.notify(warning, 'warning');
    await open(url);
    ctx.ui.notify(`Topology studio: ${url}${reused ? ' (already running)' : ''}`, 'info');
  }

  const settingsPath = () => options.settingsPath ?? defaultSettingsPath();

  // Options for /studio pick, deduplicated by realpath: this cwd, configured projects, then live instances.
  async function pickOptions(cwd: string): Promise<PickOption[]> {
    const byReal = new Map<string, { path: string; name?: string }>();

    const add = (dir: string, name: string | undefined): void => {
      const real = realOrResolved(dir), existing = byReal.get(real);
      if (!existing) byReal.set(real, { path: dir, name });
      else if (existing.name === undefined && name !== undefined) existing.name = name;
    };
    add(cwd, undefined);
    for (const project of readProjects(settingsPath())) add(project.path, project.label);
    const live = await listInstances(registry);
    for (const record of live) add(record.project, undefined);
    const running = new Set(live.map(record => record.project));
    return [...byReal].map(([real, { path: dir, name }]) => ({
      path: dir,
      label: `${name ?? path.basename(dir)} — ${dir}${running.has(real) ? ' (running)' : ''}`,
    }));
  }

  async function pick(ctx: Ctx): Promise<void> {
    const choices = await pickOptions(ctx.cwd);
    if (!ctx.hasUI || typeof ctx.ui.select !== 'function') {
      return ctx.ui.notify(`Projects:\n${choices.map(c => c.path).join('\n')}\nRun /studio <path>`, 'info');
    }
    const picked = await ctx.ui.select('Open Topology studio for', choices.map(c => c.label));
    const choice = choices.find(c => c.label === picked);
    if (choice) await ensure(choice.path, ctx);
  }

  function collectMenu(data: MenuData | undefined): void {
    if (data?.version !== 1 || typeof data.add !== 'function') return;
    data.add({
      id: 'topology-studio',
      key: 's',
      label: 'Studio',
      items: [
        { key: 'o', label: 'Open this project', command: { name: 'studio' } },
        { key: 'p', label: 'Pick project…', command: { name: 'studio', args: 'pick' } },
        { key: 'x', label: 'Stop this project', command: { name: 'studio', args: 'stop' } },
        { key: 'a', label: 'Open all-projects view', command: { name: 'studio', args: 'all' } },
        ...readProjects(settingsPath()).map(p => ({ key: p.key, label: p.label, command: { name: 'studio', args: p.path } })),
      ],
    });
  }

  async function handler(args: string, ctx: Ctx): Promise<void> {
    try {
      const parsed = parseStudioArgs(args, ctx.cwd);
      if (parsed.kind === 'ensure') return await ensure(parsed.dir, ctx);
      if (parsed.kind === 'open') {
        const record = await findInstance(ctx.cwd, registry);
        if (record === null) return ctx.ui.notify(`Topology studio is not running for ${ctx.cwd}. Run /studio to start it.`, 'info');
        await open(record.url);
        return ctx.ui.notify(`Topology studio: ${record.url}`, 'info');
      }
      if (parsed.kind === 'pick') return await pick(ctx);
      if (parsed.kind === 'all') return await ensureAll(ctx);
      if (parsed.kind === 'stop') {
        const stopped = await stopInstance(ctx.cwd, stopOptions);
        return ctx.ui.notify(stopped ? 'Topology studio stopped' : `Topology studio is not running for ${ctx.cwd}`, 'info');
      }
      if (parsed.kind === 'unknown') ctx.ui.notify(`Unknown argument: ${parsed.arg}. Use /studio, /studio open, /studio stop, /studio pick, /studio all or /studio <path>. Write a directory named like a subcommand as ./<name>.`, 'error');
    } catch (error) {
      // The handler never throws: Pi shows the message, including "Project not found" and the tool's own-repo refusal.
      ctx.ui.notify(messageOf(error) ?? String(error), 'error');
    }
  }

  return (pi: Pi): void => {
    pi.registerCommand('studio', {
      description: 'Open Topology studio for this project (/studio open | stop | pick | all | <path>)',
      getArgumentCompletions: prefix => {
        const matches = subcommands.filter(name => name.startsWith(prefix ?? ''));
        return matches.length ? matches.map(name => ({ value: name, label: name })) : null;
      },
      handler,
    });
    // Leader Key (Ctrl+X, More, Studio). Settings are read on every collect, so edits apply without a reload.
    pi.events?.on('command-menu:collect:v1', collectMenu);
    // No session_shutdown handler: the studio is detached and outlives the Pi session (C3, decisions.md D8).
  };
}
