#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { toolRoot as root } from '../server/tool-root.ts';
function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) { console.error(result.error.message); process.exit(1); }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const argv = process.argv.slice(2);
if (argv[0] && !argv[0].startsWith('-')) {
  const { main } = await import('./cli.ts');
  await main(argv);
} else {
  const help = argv.includes('--help') || argv.includes('-h');
  const flags = ['--project', '--runs-from', '--port', '--dev-token', '--no-open', '--rebuild', '--no-token', '--all', '--public-origin'];
  const unknown = argv.find((arg, i) => arg.startsWith('-') && !flags.includes(arg) && (arg.startsWith('--') || !['--project', '--runs-from', '--port', '--dev-token', '--public-origin'].includes(argv[i - 1])));
  if (help || unknown) {
    if (!help) console.error(`Invalid or missing argument: ${unknown}`);
    console.log('Usage: npm start -- --project <dir> [--runs-from <dir>] [--port <n>] [--no-open] [--rebuild] [--no-token [--public-origin <url>]]\nTailnet: --no-token disables the token check (private networks only).\nGateway: --public-origin https://studio.example.test also allows saves from that exact origin; it needs --no-token and is not authentication.\nDev: --dev-token <token> requires --no-open\nAll projects: --all lists every project with .pi/workflows; --project <dir> then preselects it.');
    process.exit(help ? 0 : 1);
  }
  const serverArgs = argv.filter(arg => arg !== '--rebuild');
  // Fail on bad arguments before any install or build.
  const { parseServerArgs } = await import('../server/args.ts');
  const { messageOf } = await import('../server/narrow.ts');
  let parsed = true;
  try { parseServerArgs(serverArgs); } catch (e) { console.error(messageOf(e)); process.exitCode = 1; parsed = false; }
  if (parsed) {
    const { isSourceCheckout, needsBuild, writeStamp } = await import('./build-stamp.ts');
    // An installed package has no web/src. It ships a prebuilt web/dist and never installs or builds itself.
    if (isSourceCheckout(root)) {
      if (!existsSync(path.join(root, 'node_modules'))) {
        console.log('Installing dependencies (first run)...'); run('npm', ['install']);
      }
      if (await needsBuild(root, { rebuild: argv.includes('--rebuild') })) {
        console.log('Building web app...'); run(path.join(root, 'node_modules/.bin/vite'), ['build', 'web']); await writeStamp(root);
      }
    }
    const { main } = await import('../server/main.ts');
    await main(serverArgs);
  }
}
