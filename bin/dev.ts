import { supervise } from './supervise.ts';
import { resolveEntry, toolRoot as root } from '../server/tool-root.ts';
const args = process.argv.slice(2);
console.log('Dev: http://127.0.0.1:4821/?token=devtoken');
process.exitCode = await supervise([
  { command: process.execPath, args: [resolveEntry('server/main'), ...args, '--api-only', '--no-open', '--port', '4822', '--dev-token', 'devtoken'], cwd: root },
  { command: 'node_modules/.bin/vite', args: ['web', '--host', '127.0.0.1', '--port', '4821', '--strictPort'], cwd: root },
]);
