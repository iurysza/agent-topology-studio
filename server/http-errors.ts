// The one place that maps tagged errors to HTTP responses. A new tag in Mapped without a case here is a type error.
import * as Match from 'effect/Match';
import { StaleError, RoleError, ProjectPathError, RunIdError, RequestError } from './errors.ts';

type Mapped = StaleError | RoleError | ProjectPathError | RunIdError | RequestError;

type ErrorBody = { error: string; hash?: string | null };

const isMapped = (error: unknown): error is Mapped => error instanceof StaleError || error instanceof RoleError || error instanceof ProjectPathError
  || error instanceof RunIdError || error instanceof RequestError;

export const errorResponse = (cause: unknown): { status: number; body: ErrorBody } | null => isMapped(cause) ? Match.valueTags(cause, {
  StaleError: (e: StaleError) => ({ status: 409, body: { error: e.message, hash: e.currentSha256 } }),
  RoleError: (e: RoleError) => ({ status: 422, body: { error: e.message } }),
  ProjectPathError: (e: ProjectPathError) => ({ status: 422, body: { error: e.message } }),
  RunIdError: (e: RunIdError) => ({ status: 400, body: { error: e.message } }),
  RequestError: (e: RequestError) => ({ status: e.status, body: { error: e.message } }),
}) : null;
