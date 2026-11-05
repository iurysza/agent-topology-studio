import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { encodeCwd } from '../shared/session-paths.ts';
import { sessionRunsRoot } from '../server/session-paths.ts';

test('encodeCwd follows Pi separator, drive-prefix and leading-dash rules exactly', () => {
  for (const [cwd, expected] of [
    ['/Users/me/project', 'Users-me-project'],
    ['C:\\Users\\me\\project', 'Users-me-project'],
    ['z:/Users/me/project', 'Users-me-project'],
    ['///--project/a\\b', 'project-a-b'],
    ['C:relative/path', 'C:relative-path'],
    ['/C:/project', 'C:-project'],
    ['/', ''],
    ['relative//project/', 'relative--project-'],
  ]) assert.equal(encodeCwd(cwd), expected, cwd);
  assert.equal(sessionRunsRoot('/Users/me/project', '/tmp/test', 501), path.join('/tmp/test', 'pi-subagents-501', 'Users-me-project'));
});

test('sessionRunsRoot preserves trailing slashes, root projects, relative temp dirs, default uid and backslashes', () => {
  for (const [projectDir, tmpDir, uid, expected] of /** @type {[string, string, number | string, string][]} */ ([
    ['/home/dev/project', '/tmp/t/', 1000, '/tmp/t/pi-subagents-1000/home-dev-project'],
    ['/', '/tmp/t', 1000, '/tmp/t/pi-subagents-1000'],
    ['/home/dev/project', 'tmp', 1000, 'tmp/pi-subagents-1000/home-dev-project'],
    ['/home/dev/project', '/tmp/t', 'default', '/tmp/t/pi-subagents-default/home-dev-project'],
    ['/home/dev/project\\nested', '/tmp/t', 1000, '/tmp/t/pi-subagents-1000/home-dev-project-nested'],
  ])) assert.equal(sessionRunsRoot(projectDir, tmpDir, uid), expected, JSON.stringify([projectDir, tmpDir, uid]));
});
