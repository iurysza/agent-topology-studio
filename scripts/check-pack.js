// Lists what npm pack would ship and fails if a runtime file is missing, a dev file leaks in, or a shipped import does not ship.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));

const fail = message => { console.error(`check-pack: ${message}`); process.exit(1); };

if (!existsSync(new URL('../dist/bin/studio.js', import.meta.url))) fail('dist/bin/studio.js is missing, run npm run build:ts first');

// toolRoot stops at the first package.json above it (D3), so none may sit inside dist/, shipped or not.
const distManifests = readdirSync(path.join(root, 'dist'), { recursive: true, withFileTypes: true })
  .flatMap(entry => entry.isFile() && entry.name === 'package.json' ? [path.relative(root, path.join(entry.parentPath, entry.name))] : []);

if (distManifests.length) fail(`${distManifests.join(', ')} must not exist, toolRoot would stop there`);

if (!existsSync(new URL('../web/dist/index.html', import.meta.url))) fail('web/dist/index.html is missing, run npm run build:web first');

const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' });

if (result.error || result.status !== 0) fail(`npm pack failed: ${result.error?.message ?? result.stderr}`);

const [pack] = JSON.parse(result.stdout);

const paths = pack.files.map(file => file.path);

const shipped = new Set(paths);

const required = [
  'package.json', 'README.md', 'LICENSE',
  'dist/bin/studio.js', 'dist/bin/cli.js', 'dist/bin/build-stamp.js', 'dist/bin/instances.js',
  'dist/server/main.js', 'dist/server/args.js', 'dist/server/tool-root.js',
  'dist/shared/machine.js', 'dist/shared/runner.js', 'dist/shared/machine.d.ts',
  'dist/pi/extension.js', 'dist/pi/studio.js',
  'web/dist/index.html', 'web/dist/fonts/IoskeleyMono-LICENSE.txt', 'reference/cli.md',
  // Bundled code and fonts drop their own licence files, so these carry the notices (web/public/).
  'web/dist/THIRD_PARTY_NOTICES.txt', 'web/dist/fonts/Inter-LICENSE.txt',
];

// Source folders ship only as compiled dist/ files.
const forbidden = ['bin/', 'server/', 'shared/', 'pi/', 'test/', 'fixtures/', 'playground/', 'ai-artifacts/', '.pi/', 'web/src/', 'tools/', 'scripts/', 'node_modules/'];

// web/dist/.build-stamp is written by build:web. An installed copy never reads it.
const allowed = new Set(['web/dist/.build-stamp']);

// Relative edges: static (also export ... from), dynamic and side-effect imports.
const relativePatterns = [/\bfrom\s*['"](\.\.?\/[^'"]+)['"]/g, /\bimport\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g, /\bimport\s*['"](\.\.?\/[^'"]+)['"]/g];

const importsOf = file => {
  const code = readFileSync(path.join(root, file), 'utf8');

  return [...new Set(relativePatterns.flatMap(pattern => [...code.matchAll(pattern)].map(match => match[1])))];
};

const unshippedImports = paths.filter(file => file.endsWith('.js') && !file.startsWith('web/dist/')).flatMap(file => importsOf(file)
  .filter(specifier => !shipped.has(path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))))
  .map(specifier => `${file} imports ${specifier}, which does not ship`));

const problems = [
  ...required.filter(file => !shipped.has(file)).map(file => `missing ${file}`),
  ...paths.filter(file => forbidden.some(prefix => file.startsWith(prefix))).map(file => `must not ship ${file}`),
  // D13: the temporary source shim bin/studio.js never ships. The forbidden bin/ prefix covers it; this names it.
  ...(shipped.has('bin/studio.js') ? ['must not ship the source shim bin/studio.js'] : []),
  ...paths.filter(file => file.endsWith('.ts') && !file.endsWith('.d.ts')).map(file => `must not ship TypeScript source ${file}`),
  ...paths.filter(file => file.startsWith('dist/') && path.posix.basename(file) === 'package.json').map(file => `must not ship ${file}, toolRoot would stop there`),
  ...paths.filter(file => file.split('/').some(part => part.startsWith('.')) && !allowed.has(file)).map(file => `unexpected dotfile ${file}`),
  ...(paths.length >= 100 ? [`${paths.length} files, expected fewer than 100`] : []),
  ...unshippedImports,
];

if (problems.length) fail(problems.join('\n'));

console.log(`pack ok: ${paths.length} files, ${pack.size} bytes`);
