import path from 'node:path';
import { encodeCwd } from '../shared/session-paths.ts';

export function sessionRunsRoot(projectDir: string, tmpDir: string, uid: number | string): string {
  return path.join(tmpDir, `pi-subagents-${uid}`, encodeCwd(projectDir));
}
