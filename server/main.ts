import { randomBytes } from 'node:crypto';
import { access, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { openProject } from './project.ts';
import { createServer } from './http.ts';
import { parseServerArgs } from './args.ts';
import { createRegistry } from './registry.ts';
import { toolRoot } from './tool-root.ts';
import { isAddressInfo, isHinted, messageOf } from './narrow.ts';

type Registry = ReturnType<typeof createRegistry>;

export async function main(argv: readonly string[] = process.argv.slice(2)) {
  try {
    const options = parseServerArgs(argv);
    if (options.help) { console.log('Usage: npm start -- --project <dir> [--runs-from <dir>] [--port <n>] [--no-open] [--rebuild] [--no-token [--public-origin <url>]]\nTailnet: --no-token disables the token check (use only behind a private network).\nGateway: --public-origin https://studio.example.test also allows saves from that exact origin; it needs --no-token and is not authentication.\nDev: --dev-token <token> requires --no-open\nDev: --api-only serves the API without the built app\nAll projects: --all lists every project with .pi/workflows; --project <dir> then preselects it.'); return; }
    const webRoot = options.apiOnly ? null : path.join(toolRoot, 'web/dist');
    const registry = options.all ? createRegistry({ toolRoot, extra: options.project ? [options.project] : [] }) : null;
    const target = registry ? { project: null, registry } : { project: await openProject(required(options.project), { toolRoot, runsFrom: options.runsFrom }), registry };
    if (webRoot !== null) try { await access(path.join(webRoot, 'index.html')); } catch { throw new Error('Run npm start, not server/main.js'); }
    const token = options.noToken ? null : options.devToken ?? randomBytes(24).toString('hex');
    const server = createServer({ ...target, token, webRoot, publicOrigin: options.publicOrigin ?? null });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port, '127.0.0.1', resolve); });
    const address = server.address();
    if (address === null) throw new TypeError("Cannot read properties of null (reading 'port')");
    const url = `http://127.0.0.1:${isAddressInfo(address) ? address.port : undefined}${token === null ? '/' : `/?token=${encodeURIComponent(token)}`}${registry && options.project ? await preselect(registry, options.project) : ''}`;
    console.log(`Topology studio: ${url}`);
    if (options.open) { const child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' }); child.on('error', e => console.error(`Open this URL in your browser: ${e.message}`)); }
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); server.closeIdleConnections(); });
    return server;
  // A detached child (bin/instances.ts) logs to a file, not a TTY, so Pi sees the bare message without the CLI hint.
  } catch (e) { console.error(isHinted(e) && e.hint && process.stderr.isTTY ? `${messageOf(e)} (${e.hint})` : messageOf(e)); process.exitCode = 1; }
}

/** parseServerArgs requires --project unless --all, so this never throws. It names the same rule. */
function required(dir: string | undefined): string {
  if (dir === undefined) throw new Error('--project <dir> is required');

  return dir;
}

/** The #/p/<id>/ hash for a listed --project, or '' after printing the registry's warning for it. */
async function preselect(registry: Registry, dir: string) {
  const { projects, warnings } = await registry.list();
  const root = await realpath(dir).catch(() => null);
  const entry = root === null ? undefined : projects.find(p => p.root === root);
  if (entry) return `#/p/${entry.id}/`;
  const warning = warnings.find(w => w.startsWith('--project ')) ?? `--project ${dir}: not listed`;
  console.error(warning.replace(/\s*\n\s*/g, ' '));
  return '';
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
