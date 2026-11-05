// Checks that every compiled workflow copy, including the editable playground when present, embeds the current runner.
// playground/ is an untracked local copy made by ./reset-playground.sh, so it is skipped when absent.
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { runner } from '../shared/runner.ts';
const stale = [];
for (const directory of ['fixtures/playground/.pi/workflows/', 'playground/.pi/workflows/', '.pi/workflows/']) {
  const dir = new URL(`../${directory}`, import.meta.url);

  if (directory === 'playground/.pi/workflows/' && !existsSync(dir)) continue;
  for (const file of await readdir(dir)) {
    if (!file.endsWith('.js') || directory === '.pi/workflows/' && file !== 'council.js') continue;
    if (!(await readFile(new URL(file, dir), 'utf8')).endsWith(runner)) stale.push(`${directory}${file}`);
  }
}
for (const file of stale) console.error(`${file} has a stale runner`);
if (stale.length) process.exitCode = 1;
else console.log('runner copies ok');
