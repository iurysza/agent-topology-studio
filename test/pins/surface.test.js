// In-process pins for contract.md channels A to E, run once per tree against golden/surface.json.
// The golden file comes from the base commit. Never regenerate it from new code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { matchGolden } from './golden.js';
import { root, trees } from './tree.js';

const GOLDEN = 'surface.json';

// A fixed list, not a folder read: new modules (server/tool-root, server/narrow) have their own tests.
// bin/studio, bin/dev and bin/check-workflow run when imported, so they are not here.
const modules = [
  'shared/literal', 'shared/machine', 'shared/ops', 'shared/refs', 'shared/replay', 'shared/runner', 'shared/session-paths',
  'server/args', 'server/catalog', 'server/check', 'server/edge', 'server/errors', 'server/git', 'server/http-errors',
  'server/http', 'server/main', 'server/project-fs', 'server/project', 'server/registry', 'server/roles', 'server/runs',
  'server/services', 'server/session-paths',
  'bin/build-stamp', 'bin/cli', 'bin/instances', 'bin/supervise',
  'pi/studio', 'pi/extension',
];

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

/** @param {string} file @returns {Promise<Record<string, any>>} */
const load = file => import(pathToFileURL(file).href);

/**
 * What `typeof value` gives for a value from this realm. Written without `typeof`, so the pin adds no
 * no-runtime-typeof warning: the pin records a kind, it does not narrow input.
 * @param {unknown} value
 * @returns {string}
 */
function kindOf(value) {
  if (value === undefined) return 'undefined';

  if (value === null) return 'object';

  if (value instanceof Function) return 'function';

  if (Object(value) === value) return 'object';

  return Object.getPrototypeOf(Object(value)).constructor.name.toLowerCase();
}

/** @param {unknown} value @returns {boolean} */
const isClass = value => value instanceof Function && /^class\b/.test(Function.prototype.toString.call(value));

/** Sorted export names, the typeof of each export and, for classes, the class name. @param {Record<string, any>} mod */
function surface(mod) {
  return Object.keys(mod).sort().map(name => {
    const value = mod[name];

    return isClass(value) ? { name, type: kindOf(value), className: value.name } : { name, type: kindOf(value) };
  });
}

/** Call an extension factory with a fake pi and record what it registers, in order. @param {Record<string, any>} mod */
function registrations(mod) {
  /** @type {{ name: string, handler: string, description: unknown }[]} */
  const commands = [];

  /** @type {{ via: string, event: string }[]} */
  const events = [];

  const pi = {
    /** @param {string} name @param {{ handler: unknown, description: unknown }} command */
    registerCommand: (name, command) => { commands.push({ name, handler: kindOf(command.handler), description: command.description }); },
    /** @param {string} event */
    on: event => { events.push({ via: 'on', event }); },
    events: {
      /** @param {string} event */
      on: event => { events.push({ via: 'events.on', event }); },
    },
  };

  mod.default(pi);

  return { defaultType: kindOf(mod.default), commands, events };
}

for (const tree of trees()) {
  test(`A: module surface (${tree.name})`, async t => {
    for (const rel of modules) matchGolden(t, GOLDEN, `A:${rel}`, surface(await load(tree.file(rel))));
  });

  test(`B: runner bytes (${tree.name})`, async t => {
    const { runner } = await load(tree.file('shared/runner'));

    matchGolden(t, GOLDEN, 'B:runner', { sha256: createHash('sha256').update(runner).digest('hex'), length: runner.length });
  });

  test(`C: tagged errors (${tree.name})`, async t => {
    const errors = await load(tree.file('server/errors'));

    const instances = {
      ProjectPathError: new errors.ProjectPathError(),
      StaleError: new errors.StaleError({ baseSha256: 'aaa', currentSha256: null }),
      RoleError: new errors.RoleError({ message: 'Role not found: x' }),
      RunIdError: new errors.RunIdError({ message: 'Invalid run id' }),
      RequestError: new errors.RequestError({ status: 400, message: 'Bad request' }),
      Problems: new errors.Problems({ problems: ['first', 'second'], warnings: ['careful'] }),
      FsError: new errors.FsError({ op: 'read', path: '/x/y', cause: new Error('boom') }),
    };

    assert.deepStrictEqual(Object.keys(instances).sort(), Object.keys(errors).sort(), 'every class server/errors exports has an instance');

    for (const [name, error] of Object.entries(instances)) {
      matchGolden(t, GOLDEN, `C:${name}`, {
        message: error.message,
        tag: error._tag,
        isError: error instanceof Error,
        json: JSON.stringify(error),
        keys: Object.keys(error),
      });
    }
  });

  test(`D: pi extension (${tree.name})`, async t => {
    matchGolden(t, GOLDEN, 'D:extension', registrations(await load(tree.file('pi/extension'))));
  });

  test(`E: package surface (${tree.name})`, async t => {
    const subpaths = Object.keys(pkg.exports).sort();

    /** @type {Record<string, string[]>} */
    const names = {};

    for (const subpath of subpaths) {
      const specifier = `${pkg.name}${subpath.slice(1)}`;

      const mod = subpath.endsWith('.json') ? await import(specifier, { with: { type: 'json' } }) : await import(specifier);

      names[subpath] = Object.keys(mod).sort();
    }

    matchGolden(t, GOLDEN, 'E:package', { exports: subpaths, names, bin: Object.keys(pkg.bin).sort() });
  });
}

// Not per tree: the extension Pi actually loads. From S5 it points into dist/.
test('D: pi extension (package.json pi.extensions[0])', async t => {
  matchGolden(t, GOLDEN, 'D:extension', registrations(await load(path.resolve(root, pkg.pi.extensions[0]))));
});
