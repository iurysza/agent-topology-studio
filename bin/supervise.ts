import { spawn, type ChildProcess } from 'node:child_process';
const SIGNAL_CODES = new Set<number | null>([130, 143]);
const SIGNALS = new Set<NodeJS.Signals | null>(['SIGINT', 'SIGTERM']);
const SIGNAL_GRACE_MS = 250;

export type Child = { command: string; args?: string[]; cwd?: string };
// Spawns each child and resolves an exit code. A Ctrl-C reaches the whole process group,
// so a child may exit by signal before our own handler runs: wait briefly for it before calling that a failure.
export function supervise(children: readonly Child[]): Promise<number> {
  return new Promise(resolve => {
    let parentSignalled = false, settled = false, code: number | null = null, pending: number | null = null, alive = children.length;
    const procs: ChildProcess[] = [];
    const stopAll = () => { for (const proc of procs) if (proc.exitCode === null && proc.signalCode === null) proc.kill(); };
    const finish = (value: number) => { code ??= value; stopAll(); };
    const onSignal = () => { parentSignalled = true; finish(0); };
    process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
    const settle = () => {
      if (settled || alive > 0 || code === null) return;
      settled = true;
      process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
      resolve(code);
    };
    // Any child exit we did not start stops the rest. A signal exit counts as 1.
    // While a signal-style exit waits out the grace window, later exits do not take the result.
    const decide = (exitCode: number | null) => { if (code === null && pending === null) finish(exitCode ?? 1); };
    for (const { command, args = [], cwd } of children) {
      const proc = spawn(command, args, { cwd, stdio: 'inherit' });
      procs.push(proc);
      let gone = false;
      const done = () => { if (gone) return; gone = true; alive--; settle(); };
      proc.on('error', error => {
        if (code === null && pending === null) { console.error(`${command}: ${error.message}`); finish(1); }
        done();
      });
      proc.on('exit', (exitCode, signal) => {
        const bySignal = SIGNALS.has(signal) || SIGNAL_CODES.has(exitCode);
        if (bySignal && parentSignalled) return done();
        if (bySignal && code === null) {
          pending ??= exitCode ?? 1;
          const held = pending;
          setTimeout(() => { if (!parentSignalled) finish(held); done(); }, SIGNAL_GRACE_MS);
          return;
        }
        decide(exitCode);
        done();
      });
    }
  });
}
