import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openProject } from '../server/project.ts';
import { createServer } from '../server/http.ts';

async function setup(t) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'studio-catalog-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const dir = path.join(tmp, 'project'), home = path.join(tmp, 'home');
  await mkdir(dir); t.mock.method(os, 'homedir', () => home);
  return { dir, home, project: await openProject(dir) };
}

test('catalog GET unions built-ins, role names and installed project and home skills without writes', async t => {
  const { dir, home, project } = await setup(t);
  for (const skill of [path.join(dir, '.pi/skills/local'), path.join(home, '.pi/agent/skills/global'), path.join(home, '.pi/agent/skills/local')]) {
    await mkdir(skill, { recursive: true }); await writeFile(path.join(skill, 'SKILL.md'), '# Skill\n');
  }
  await mkdir(path.join(dir, '.pi/skills/no-skill'));
  await mkdir(path.join(dir, '.pi/skills/not-a-file/SKILL.md'), { recursive: true });
  await writeFile(path.join(dir, '.pi/skills/plain-file'), 'not a skill directory');
  await project.createRole({ name: 'custom', tools: ['z_custom', 'read', 'z_custom'], skills: ['role-only', 'local', 'role-only'], body: 'Body\n' });
  const roleFile = path.join(dir, '.pi/agents/custom.md'), before = await readFile(roleFile, 'utf8');
  const listing = await readdir(path.join(dir, '.pi/skills'));
  const expected = {
    tools: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'codemode', 'web_search', 'fetch_content', 'get_search_content', 'Agent', 'SubagentWorkflow', 'ask_user', 'z_custom'].sort(),
    skills: ['global', 'local', 'role-only'],
  };
  const server = createServer({ project, token: 'token', webRoot: dir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}/api/catalog`;
  const response = await fetch(url, { headers: { 'X-Studio-Token': 'token' } });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), expected);
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: { 'X-Studio-Token': 'token' } })).status, 405);
  assert.equal(await readFile(roleFile, 'utf8'), before);
  assert.deepEqual(await readdir(path.join(dir, '.pi/skills')), listing);
  await rm(path.join(home, '.pi/agent/skills'), { recursive: true });
  assert.deepEqual((await project.catalog()).skills, ['local', 'role-only']);
});

test('catalog tolerates missing skill directories and includes newly added role names', async t => {
  const { project } = await setup(t);
  const empty = await project.catalog();
  assert.deepEqual(empty.skills, []); assert.ok(empty.tools.includes('Agent'));
  await project.createRole({ name: 'new-role', tools: ['custom'], skills: ['not-installed'] });
  assert.deepEqual((await project.catalog()).tools, [...empty.tools, 'custom'].sort());
  assert.deepEqual((await project.catalog()).skills, ['not-installed']);
});
