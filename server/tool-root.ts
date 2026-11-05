// The package root and the running tree (ADR-0006). Only node: built-ins: bin/studio loads this before npm install.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** @returns The nearest directory at or above start that holds a package.json. */
function packageRoot(start: string): string {
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;

    if (path.dirname(dir) === dir) throw new Error(`No package.json above ${start}`);
  }
}

/** The package root: the repository from source and from dist/, the installed package dir from node_modules. */
export const toolRoot = packageRoot(path.dirname(fileURLToPath(import.meta.url)));

/** The root of the running tree: the repository from source, dist/ from dist/. */
export const codeRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * The file that runs `rel` in the running tree: `<codeRoot>/<rel>.ts` when it exists, else `<codeRoot>/<rel>.js`.
 * @param rel A path such as `server/main`, with or without `.js` or `.ts`.
 */
export function resolveEntry(rel: string): string {
  const base = rel.replace(/\.(js|ts)$/, '');

  for (const ext of ['.ts', '.js']) {
    const file = path.join(codeRoot, base + ext);

    if (existsSync(file)) return file;
  }

  throw new Error(`No entry ${rel}`);
}
