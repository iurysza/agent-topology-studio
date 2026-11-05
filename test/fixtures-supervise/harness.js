// Supervises two children that run until signalled. Each child prints "up" on the shared stdout
// once its handlers are in place, so the test knows both have spawned before it sends Ctrl-C.
import { supervise } from '../../bin/supervise.ts';
const wait = "process.on('SIGINT', () => process.exit(130)); process.on('SIGTERM', () => process.exit(143)); setInterval(() => {}, 1000); console.log('up');";
const child = { command: process.execPath, args: ['-e', wait] };
process.exitCode = await supervise([child, child]);
