// Tagged errors for the server. They stay plain Errors, so instanceof and the HTTP mapping keep working.
import * as Data from 'effect/Data';

export class ProjectPathError extends Data.TaggedError('ProjectPathError') {
  override get message() { return 'Workflow and role paths must stay inside the project'; }
}
export class StaleError extends Data.TaggedError('StaleError')<{ baseSha256: string | null; currentSha256: string | null }> {
  override get message() { return 'The file changed on disk since it was loaded. Reload before saving.'; }
}
export class RoleError extends Data.TaggedError('RoleError')<{ message: string }> {}
export class RunIdError extends Data.TaggedError('RunIdError')<{ message: string }> {}
export class RequestError extends Data.TaggedError('RequestError')<{ status: number; message: string }> {}
export class Problems extends Data.TaggedError('Problems')<{ problems: string[]; warnings: string[] }> {
  override get message() { return this.problems.join('\n'); }
}
// Never reaches callers: runEdge unwraps it to the raw Node error in cause.
export class FsError extends Data.TaggedError('FsError')<{ op: string; path: string; cause: unknown }> {}
