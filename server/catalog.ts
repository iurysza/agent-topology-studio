import { readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { isErrno } from './narrow.ts';

/** The fields of a role record that the catalog reads. */
export type CatalogRole = { readonly tools: readonly string[]; readonly skills: readonly string[] };

export type Catalog = { tools: string[]; skills: string[] };

type Guard = (target: string) => string;

const builtins = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'codemode', 'web_search', 'fetch_content', 'get_search_content', 'Agent', 'SubagentWorkflow', 'ask_user'];

export async function readCatalog(root: string, contained: Guard, roles: readonly CatalogRole[], homeSkills: string): Promise<Catalog> {
  const tools = new Set([...builtins, ...roles.flatMap(role => role.tools)]);
  const skills = new Set(roles.flatMap(role => role.skills));
  const sources: [string, Guard][] = [
    [path.join(root, '.pi/skills'), contained],
    [homeSkills, target => target],
  ];

  for (const [dir, guard] of sources) {
    let entries: Dirent[];
    try { entries = await readdir(guard(dir), { withFileTypes: true }); }
    catch (error) { if (isErrno(error) && error.code === 'ENOENT') continue; throw error; }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

      try {
        if ((await stat(guard(path.join(dir, entry.name, 'SKILL.md')))).isFile()) skills.add(entry.name);
      } catch (error) { if (!isErrno(error) || error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    }
  }

  return { tools: [...tools].sort(), skills: [...skills].sort() };
}
