// Effect versions of the project file helpers. Every fs call goes through ProjectFs and fails with FsError.
import * as Effect from 'effect/Effect';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { FsError, ProjectPathError } from './errors.ts';
import { ProjectFs } from './services.ts';
import { isErrno } from './narrow.ts';

export const attempt = <A>(op: string, file: string, run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: cause => new FsError({ op, path: file, cause }) });

export const isMissing = (cause: unknown) => cause instanceof FsError && isErrno(cause.cause) && cause.cause.code === 'ENOENT';

const orWhenMissing = <A, B>(effect: Effect.Effect<A, FsError, ProjectFs>, fallback: B): Effect.Effect<A | B, FsError, ProjectFs> =>
  Effect.catchIf(effect, isMissing, () => Effect.succeed(fallback));

export const readText = (file: string) => Effect.gen(function* () {
  const fs = yield* ProjectFs;
  return yield* attempt('read', file, () => fs.readFile(file, 'utf8'));
});

/** Gives null when the file does not exist. */
export const optionalRead = (file: string) => orWhenMissing(readText(file), null);

/** Gives [] when the directory does not exist. */
export const list = (dir: string) => orWhenMissing(Effect.gen(function* () {
  const fs = yield* ProjectFs;
  return yield* attempt('readdir', dir, () => fs.readdir(dir));
}), [] satisfies string[]);

/**
 * Writes through a temp file in the same directory, then renames it over the target.
 * Mirrors the original try/finally exactly: the finally step closes a handle that is still open
 * (including after a failed close), then removes the temp file. A failure in the finally step
 * replaces the original error and skips the rest of the finally step, so the steps run in sequence
 * here instead of relying on Effect's cause ordering.
 */
export const atomicWrite = (file: string, content: string) => Effect.gen(function* () {
  const fs = yield* ProjectFs;
  const dir = path.dirname(file);
  yield* attempt('mkdir', dir, () => fs.mkdir(dir, { recursive: true }));
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let handle: FileHandle | null = null;
  const body = Effect.gen(function* () {
    const opened = yield* attempt('open', temp, () => fs.open(temp, 'wx'));
    handle = opened;
    yield* attempt('write', temp, () => opened.writeFile(content));
    yield* attempt('sync', temp, () => opened.sync());
    yield* attempt('close', temp, () => opened.close());
    handle = null;
    yield* attempt('rename', file, () => fs.rename(temp, file));
  });
  const exit = yield* Effect.exit(body);
  // SAFETY: body above may set handle; tsc does not track writes inside the generator closure and narrows it to null.
  const open = handle as FileHandle | null;
  if (open) yield* attempt('close', temp, () => open.close());
  yield* attempt('rm', temp, () => fs.rm(temp, { force: true }));
  return yield* exit;
});

/** Gives true after removing the file, false when it does not exist. */
export const removeFile = (file: string) => orWhenMissing(Effect.gen(function* () {
  const fs = yield* ProjectFs;
  yield* attempt('rm', file, () => fs.rm(file));
  return true;
}), false);

/** Runs a sync containment check on the typed channel. Other throws, such as EACCES from realpath, become FsError. */
export const guarded = (guard: (target: string) => string, target: string) => Effect.try({
  try: () => guard(target),
  catch: cause => cause instanceof ProjectPathError ? cause : new FsError({ op: 'realpath', path: target, cause }),
});
