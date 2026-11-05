// Tree selection for the pins (contract.md "Tree selection"): the source tree, plus dist/ once it is built.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root, without a trailing separator. */
export const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** @typedef {{ readonly name: 'source' | 'dist', readonly file: (rel: string) => string }} Tree */

/**
 * The file that holds a module in the source tree: `.ts` when it exists, else `.js`.
 * @param {string} rel A path without extension, such as `server/main`.
 * @returns {string}
 */
export function sourceFile(rel) {
  const ts = path.join(root, `${rel}.ts`);

  return existsSync(ts) ? ts : path.join(root, `${rel}.js`);
}

/** @param {string} rel @returns {string} */
const distFile = rel => path.join(root, 'dist', `${rel}.js`);

/**
 * Every tree the pins run against.
 * @returns {Tree[]}
 */
export function trees() {
  /** @type {Tree[]} */
  const found = [{ name: 'source', file: sourceFile }];

  if (existsSync(distFile('bin/studio'))) found.push({ name: 'dist', file: distFile });

  return found;
}
