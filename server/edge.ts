// The only place server code runs an Effect. Public facade methods call runEdge and stay async.
import * as Effect from 'effect/Effect';
import { FsError } from './errors.ts';
import { ProjectFs } from './services.ts';

const isFsError = (error: unknown): error is FsError => error instanceof FsError;

export const runEdge = <A, E>(effect: Effect.Effect<A, E | FsError, ProjectFs>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.catchIf(isFsError, error => Effect.die(error.cause)), Effect.provide(ProjectFs.layer)))
    // catchIf skips a cause that also holds a defect (a failed close or cleanup rm), so unwrap here too.
    .catch((cause: unknown) => { throw isFsError(cause) ? cause.cause : cause; });
