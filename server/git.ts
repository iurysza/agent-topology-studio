// Reads the checked-out branch from .git/HEAD without spawning git. See home-screen decision H3.
import * as Effect from 'effect/Effect';
import path from 'node:path';
import { ProjectFs } from './services.ts';
import { attempt, optionalRead } from './project-fs.ts';

const BRANCH = /^ref: refs\/heads\/(.+?)\s*$/;

/**
 * Gives the branch name, or null when HEAD is detached, missing or unreadable. Never fails.
 * Only `<root>/.git` is checked: a directory, or a worktree file holding `gitdir: <path>`.
 */
export const readBranch = (root: string): Effect.Effect<string | null, never, ProjectFs> => Effect.gen(function* () {
  const fs = yield* ProjectFs;
  const dotGit = path.join(root, '.git');
  const info = yield* attempt('stat', dotGit, () => fs.stat(dotGit));
  let gitDir = dotGit;
  if (!info.isDirectory()) {
    const pointer = (yield* optionalRead(dotGit))?.split('\n')[0].match(/^gitdir:\s*(.+?)\s*$/);
    if (!pointer) return null;
    gitDir = path.resolve(root, pointer[1]);
  }
  const head = yield* optionalRead(path.join(gitDir, 'HEAD'));
  return head?.split('\n')[0].match(BRANCH)?.[1] ?? null;
}).pipe(Effect.orElseSucceed(() => null));
