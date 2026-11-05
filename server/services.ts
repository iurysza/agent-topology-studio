// The file system the project code reads and writes through. Tests provide a fake to inject failures.
import * as Context from 'effect/Context';
import * as Layer from 'effect/Layer';
import { readFile, readdir, stat, mkdir, open, rename, rm } from 'node:fs/promises';

export interface ProjectFsApi {
  readonly readFile: typeof readFile;
  readonly readdir: typeof readdir;
  readonly stat: typeof stat;
  readonly mkdir: typeof mkdir;
  readonly open: typeof open;
  readonly rename: typeof rename;
  readonly rm: typeof rm;
}

export class ProjectFs extends Context.Service<ProjectFs, ProjectFsApi>()('topology-studio/server/ProjectFs') {
  static layer = Layer.succeed(ProjectFs, { readFile, readdir, stat, mkdir, open, rename, rm });
}
