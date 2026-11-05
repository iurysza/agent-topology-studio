import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readdir, stat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const inputs = ['web/src', 'web/public', 'web/index.html', 'web/vite.config.ts', 'web/tsconfig.json', 'shared', 'package-lock.json'];

type Snapshot = { fingerprint: string };

type BuildOptions = { rebuild?: boolean };
// A same-size, same-mtime edit is not detected. --rebuild covers that case.
async function snapshot(root: string): Promise<Snapshot> {
  const lines: string[] = [];
  async function visit(file: string): Promise<void> {
    const s = await stat(file);
    if (s.isDirectory()) { for (const entry of await readdir(file)) await visit(path.join(file, entry)); }
    else lines.push(`${path.relative(root, file).split(path.sep).join('/')}\t${s.size}\t${s.mtimeMs}`);
  }
  for (const input of inputs) await visit(path.join(root, input));
  return { fingerprint: createHash('sha256').update(lines.sort().join('\n')).digest('hex') };
}
export function isSourceCheckout(root: string): boolean {
  return existsSync(path.join(root, 'web/src'));
}
export async function needsBuild(root: string, { rebuild = false }: BuildOptions = {}): Promise<boolean> {
  if (rebuild) return true;
  try {
    await stat(path.join(root, 'web/dist/index.html'));
    // Unvalidated. A null stamp throws the old read's TypeError, which the catch turns into a rebuild.
    const stamp: Partial<Snapshot> | null = JSON.parse(await readFile(path.join(root, 'web/dist/.build-stamp'), 'utf8'));
    if (stamp === null) throw new TypeError("Cannot read properties of null (reading 'fingerprint')");
    return stamp.fingerprint !== (await snapshot(root)).fingerprint;
  } catch { return true; }
}
export async function writeStamp(root: string): Promise<void> {
  await writeFile(path.join(root, 'web/dist/.build-stamp'), JSON.stringify({ ...await snapshot(root), builtAt: new Date().toISOString() }));
}
