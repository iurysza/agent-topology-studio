import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import type { instanceMain } from './instances.ts';
import { openProject } from '../server/project.ts';
import { checkWorkflowCode, isSafeName } from '../server/check.ts';
import { Problems } from '../server/errors.ts';
import { isHinted, messageOf } from '../server/narrow.ts';
import { toolRoot } from '../server/tool-root.ts';
import { validateMachine, compile, extract, templateMachine } from '../shared/machine.ts';
import type { Machine, State } from '../shared/machine.ts';
import { references, FIELD_NAME } from '../shared/refs.ts';
import { addAfter, addState, renameState, setField, setEvent, removeEvent } from '../shared/ops.ts';

// The flags any command may pass. main() rejects those a command does not list in commands.
const options = {
  project: { type: 'string' }, workflow: { type: 'string' }, name: { type: 'string' }, after: { type: 'string' }, kind: { type: 'string' }, role: { type: 'string' }, title: { type: 'string' },
  description: { type: 'string' }, color: { type: 'string' }, model: { type: 'string' }, thinking: { type: 'string' }, tools: { type: 'string' }, skills: { type: 'string' }, body: { type: 'string' },
  json: { type: 'boolean' }, help: { type: 'boolean' },
} as const;

type Flag = keyof typeof options;

type InstanceDeps = NonNullable<Parameters<typeof instanceMain>[1]>;

type Failure = { problems: (string | undefined)[]; warnings: string[] };

const commands = {
  list: [], catalog: [], runs: ['workflow'], run: [], show: [], get: [], put: [], new: ['name'], rm: [], refs: [], check: [], set: [],
  'add-state': ['after', 'kind', 'role', 'title'], link: ['description'], unlink: [], rename: [],
  roles: [], role: ['description', 'color', 'model', 'thinking', 'tools', 'skills', 'body'],
} satisfies Record<string, Flag[]>;

type Command = keyof typeof commands;

const isCommand = (name: string): name is Command => Object.hasOwn(commands, name);

const usage = `Usage: studio <command> [--project <dir>] [--json]
list | runs [--workflow <id>] | run <id> | show <id> | get <id> | put <id> [file|-] | new <id> [--name <title>] | rm <id>
refs <id> [state] | check [id] | set <id> <state> key=value ... (title, role, kind, prompt, gate, maxVisits, outcome)
add-state <id> <state> [--after <from>] [--kind <kind>] [--role <role>] [--title <title>]
link <id> <from> <event> <to> [--description <text>] | unlink <id> <from> <event>
rename <id> <from> <to> | catalog | roles | role <name> | role new <name> [--description <text>] [--color <color>] [--model <model>] [--thinking <level>] [--tools <csv>] [--skills <csv>] [--body <file|->]
open [--project <dir>] [--all] [--port <n>] [--no-open] [--json] | stop [--project <dir> | --all]`;

// openProject refusals carry a CLI-only hint; Pi shows the bare message.
const cliFailure = (cause: unknown): Failure => {
  if (cause instanceof Problems) return { problems: cause.problems, warnings: cause.warnings };

  // The old `error.hint` read crashed on null and undefined. Keep V8's TypeError.
  if (cause === null || cause === undefined) throw new TypeError(`Cannot read properties of ${cause} (reading 'hint')`);

  return { problems: [isHinted(cause) && cause.hint ? `${messageOf(cause)} (${cause.hint})` : messageOf(cause)], warnings: [] };
};

// The old `s.branches.some(...)`: null or undefined branches throw V8's TypeError,
// and a non-array keeps the native `s.branches.some is not a function` text.
function hasBranch(s: State, id: string): boolean {
  if (s.branches === null || s.branches === undefined) throw new TypeError(`Cannot read properties of ${s.branches} (reading 'some')`);

  return s.branches.some(b => b.id === id);
}

function count(args: string[], min: number, max = min) { if (args.length < min || args.length > max) throw new Error('Invalid arguments. Use <command> --help for usage.'); }
function stateAt(m: Machine, id: string): State { if (!Object.hasOwn(m.states, id)) throw new Error(`State \`${id}\` does not exist`); return m.states[id]; }
function outline(m: Machine): string {
  const lines = [`${m.id}: ${m.name}`, m.description, `Initial: ${m.initial}`];
  for (const [id, s] of Object.entries(m.states)) {
    lines.push(`  ${id} [${s.kind}] ${s.title}${s.role ? ` (role: ${s.role})` : ''}${s.outcome ? ` (${s.outcome})` : ''}`);
    for (const branch of s.branches ?? []) lines.push(`    ${branch.id} (role: ${branch.role})`);
    for (const [event, t] of Object.entries(s.on ?? {})) lines.push(`    ${event} -> ${t.to}${t.description ? `: ${t.description}` : ''}`);
  }
  return lines.join('\n');
}
async function stdin(): Promise<string> { const chunks: Buffer[] = []; for await (const chunk of process.stdin) chunks.push(chunk); return Buffer.concat(chunks).toString('utf8'); }
// deps is a test seam for open and stop (see instanceMain in instances.ts).
export async function main(argv: string[] = process.argv.slice(2), deps: InstanceDeps = {}): Promise<void> {
  let json = argv.includes('--json');
  try {
    const command = argv[0];
    if (command === 'open' || command === 'stop') return await (await import('./instances.ts')).instanceMain(argv, { usage, ...deps });
    if (!isCommand(command)) throw new Error(`Unknown command: ${command}`);
    const { values, positionals: args } = parseArgs({ args: argv.slice(1), allowPositionals: true, options });
    json = values.json ?? false;
    if (values.help) { console.log(usage); return; }
    const allowed: readonly string[] = ['project', 'json', ...commands[command]];
    for (const key of Object.keys(values)) if (!allowed.includes(key)) throw new Error(`--${key} does not apply to ${command}`);
    const project = await openProject(values.project ?? process.cwd(), { toolRoot });
    const roles = await project.listRoles();
    const print = <T>(data: T, text: string) => console.log(json ? JSON.stringify(data, null, 2) : text);
    const loaded = async (id: string) => {
      if (!isSafeName(id)) throw new Error('Invalid workflow id');
      const { code, sha256: hash } = await project.readScript(id);
      if (code === null) throw new Error(`Workflow \`${id}\` not found`);
      const machine = extract(code);
      if (machine === null) throw new Error(`Workflow \`${id}\` is hand-written and not editable`);
      return { machine, hash };
    };
    const save = async (id: string, machine: Machine, hash: string | null) => {
      const issues = validateMachine(machine, { roles, fileName: `${id}.js` });
      if (issues.problems.length) throw new Problems({ problems: issues.problems, warnings: issues.warnings });
      const code = compile(machine), checked = checkWorkflowCode(code, { fileName: `${id}.js` });
      const warnings = [...issues.warnings, ...checked.warnings];
      if (checked.errors.length) {
        // SAFETY: Problems prints its array as given. An undefined entry comes only from messageOf (accepted difference 8), and the old code passed it on too.
        throw new Problems({ problems: checked.errors as string[], warnings });
      }
      const result = { machine, hash: await project.writeScript(id, code, hash), warnings };
      print(result, `Saved ${id}`);
      if (!json) for (const warning of warnings) console.error(`Warning: ${warning}`);
    };
    if (command === 'runs') {
      count(args, 0); const runs = await project.listRuns(values.workflow);
      print({ runs }, runs.map(run => `${run.id}  ${run.workflow ?? '?'}  ${run.status}${run.outcome ? ` ${run.outcome}` : ''}  ${run.calls} calls  ${run.updatedAt}`).join('\n')); return;
    }
    if (command === 'run') {
      count(args, 1); const run = await project.readRun(args[0]);
      if (!run) throw new Error(`Run \`${args[0]}\` not found`);
      print(run, [`${run.id}  ${run.workflow ?? '?'}  ${run.status}${run.outcome ? ` ${run.outcome}` : ''}`, run.path.join(' -> '), ...run.steps.map(step => `${step.n}  ${step.state}${step.branch ? `:${step.branch}` : ''}  ${step.ok ? 'ok' : 'failed'}${step.event ? `  ${step.event} -> ${step.to}` : ''}`), ...(run.reason ? [run.reason] : [])].join('\n')); return;
    }
    if (command === 'list') {
      count(args, 0); const workflows = await project.listWorkflows();
      print(workflows, workflows.map(w => `${w.id}  ${w.name}  ${w.states} states${w.editable ? '' : '  not editable'}`).join('\n')); return;
    }
    if (command === 'catalog') {
      count(args, 0); const catalog = await project.catalog();
      print(catalog, `Tools: ${catalog.tools.join(', ')}\nSkills: ${catalog.skills.join(', ')}`); return;
    }
    if (command === 'roles') {
      count(args, 0); print(roles, roles.map(role => `${role.name}  ${role.color ?? '-'}  ${role.model ?? '-'}  ${role.description ?? ''}`).join('\n')); return;
    }
    if (command === 'role') {
      if (args[0] === 'new') {
        count(args, 2);
        const frontmatter = Object.fromEntries(commands.role.filter(key => key !== 'body' && values[key] !== undefined).map(key => [key, values[key]]));
        const body = values.body === undefined ? '' : values.body === '-' ? await stdin() : await readFile(values.body, 'utf8');
        const result = await project.createRole({ name: args[1], ...frontmatter, body }); print(result, `Created role ${args[1]}`); return;
      }
      count(args, 1);
      for (const key of commands.role) if (values[key] !== undefined) throw new Error(`--${key} requires role new`);
      const result = await project.readRole(args[0]); if (!result) throw new Error(`Role \`${args[0]}\` not found`);
      print(result, [result.role.name, ...Object.entries(result.role).filter(([key]) => key !== 'name').map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value ?? ''}`), '', result.body].join('\n')); return;
    }
    if (command === 'check') {
      count(args, 0, 1);
      const ids = args.length ? args : (await project.listWorkflows()).map(w => w.id), results = [];
      for (const id of ids) {
        const { code } = await project.readScript(id); if (code === null) throw new Error(`Workflow \`${id}\` not found`);
        const machine = extract(code), issues = machine === null ? { problems: [], warnings: [] } : validateMachine(machine, { roles, fileName: `${id}.js` });
        const checked = checkWorkflowCode(code, { fileName: `${id}.js` });
        results.push({ id, problems: [...issues.problems, ...checked.errors], warnings: [...issues.warnings, ...checked.warnings] });
      }
      const problems = results.flatMap(r => r.problems.map(problem => `${r.id}: ${problem}`)), warnings = results.flatMap(r => r.warnings.map(warning => `${r.id}: ${warning}`));
      if (problems.length) throw new Problems({ problems, warnings });
      print(results, results.map(r => `${r.id}: OK${r.warnings.length ? ` (${r.warnings.length} warnings)` : ''}`).join('\n'));
      if (!json) for (const warning of warnings) console.error(`Warning: ${warning}`); return;
    }
    if (command === 'new') {
      count(args, 1); const id = args[0];
      if (!isSafeName(id) || !/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error('Invalid workflow id');
      const machine = templateMachine(id); if (values.name !== undefined) machine.name = values.name;
      await save(id, machine, null); return;
    }
    if (command === 'rm') {
      count(args, 1); if (!await project.deleteScript(args[0])) throw new Error(`Workflow \`${args[0]}\` not found`);
      print({ id: args[0], removed: true }, `Removed ${args[0]}`); return;
    }
    const counts = { show: [1], get: [1], put: [1, 2], refs: [1, 2], set: [3, Infinity], 'add-state': [2], link: [4], unlink: [3], rename: [3] };
    const [min, max] = counts[command];
    count(args, min, max);
    const id = args[0], current = await loaded(id), m = current.machine;
    if (command === 'get') { console.log(JSON.stringify(m, null, 2)); return; }
    if (command === 'show') { print(m, outline(m)); return; }
    if (command === 'refs') {
      const at = args[1];
      if (at !== undefined) {
        const [state, branch, extra] = at.split('.'), s = stateAt(m, state);
        if (extra !== undefined || (branch !== undefined && (s.kind !== 'fanout' || !hasBranch(s, branch)))) throw new Error(`Prompt \`${at}\` does not exist`);
      }
      const refs = references(m, at); print(refs, refs.map(ref => `${ref.path}  ${ref.kind}${ref.description ? `  ${ref.description}` : ''}`).join('\n')); return;
    }
    let changed = m;
    if (command === 'put') {
      const file = args[1] ?? '-', text = file === '-' ? await stdin() : await readFile(file, 'utf8');
      try { changed = JSON.parse(text); } catch { throw new Error('Invalid machine JSON'); }
    } else if (command === 'set') {
      stateAt(m, args[1]);
      for (const assignment of args.slice(2)) {
        const split = assignment.indexOf('='), key = assignment.slice(0, split), value = assignment.slice(split + 1);
        if (split < 1 || !['title', 'role', 'kind', 'prompt', 'gate', 'maxVisits', 'outcome'].includes(key)) throw new Error(`Expected title, role, kind, prompt, gate, maxVisits, or outcome as key=value: ${assignment}`);
        changed = setField(changed, args[1], key, key === 'maxVisits' ? value === '' ? undefined : Number(value) : value);
      }
    } else if (command === 'add-state') {
      const name = args[1];
      if (!FIELD_NAME.test(name) || Object.hasOwn(m.states, name)) throw new Error('State id must be valid and unused');
      const from = values.after, src = from === undefined ? null : stateAt(m, from);
      const added = from === undefined ? addState(m, values.role) : addAfter(m, from, values.role);
      changed = added.id === name ? added.m : renameState(added.m, added.id, name);
      if (values.kind !== undefined) changed = setField(changed, name, 'kind', values.kind);
      if (values.title !== undefined) changed = setField(changed, name, 'title', values.title);
      const next = Object.values(src?.on ?? {})[0];
      if (next && changed.states[name].kind !== 'final') changed = setEvent(changed, name, 'done', next);
    } else if (command === 'link') {
      if (stateAt(m, args[1]).kind === 'final') throw new Error('Final states cannot have events');
      changed = setEvent(m, args[1], args[2], { to: args[3], description: values.description });
    } else if (command === 'unlink') {
      const s = stateAt(m, args[1]); if (!Object.hasOwn(s.on ?? {}, args[2])) throw new Error(`Event \`${args[2]}\` does not exist`);
      changed = removeEvent(m, args[1], args[2]);
    } else if (command === 'rename') {
      stateAt(m, args[1]); changed = renameState(m, args[1], args[2]);
      if (changed === m) throw new Error('New state id must be valid, different, and unused');
    }
    await save(id, changed, current.hash);
  } catch (error) {
    const { problems, warnings } = cliFailure(error);
    console.error(json ? JSON.stringify({ problems, warnings }, null, 2) : [...problems, ...warnings.map(warning => `Warning: ${warning}`)].join('\n'));
    process.exitCode = 1;
  }
}
