// Release gate run by .github/workflows/release.yml before npm publish. It reads ./package.json and fails unless the
// release tag, package name, repository and licence allow a public publish. Usage:
//   node scripts/check-release.js --tag v1.2.3 --repository owner/name
// Values arrive as argv, never through a shell string, so a hostile tag is compared, not executed.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const packageName = 'agent-topology-studio';

const registry = 'https://registry.npmjs.org/';

const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const trimSlash = text => text.replace(/\/+$/, '');

// Accepts the npm shorthand and the usual git URL forms, then returns owner/name or undefined.
function repositorySlug(field) {
  // A string field has no .url, so this reads either form; an object without a url becomes text that cannot match.
  const url = String(field?.url ?? field ?? '');

  const match = /^(?:github:)?([\w.-]+\/[\w.-]+)$/.exec(url) ?? /^(?:git\+)?(?:https|ssh|git):\/\/(?:git@)?github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url);

  return match?.[1];
}

function problems(pkg, tag, repository) {
  const found = [];

  if (pkg.name !== packageName) found.push(`package name is ${JSON.stringify(pkg.name)}, expected ${packageName}`);

  if (pkg.private !== false && pkg.private !== undefined) found.push('package.json has "private": true; removing it needs its own approved change');

  const license = String(pkg.license ?? '').trim();

  if (!license || license === 'UNLICENSED') found.push(`licence is ${JSON.stringify(pkg.license)}; set an approved licence before publishing`);

  if (!semver.test(String(pkg.version ?? ''))) found.push(`version ${JSON.stringify(pkg.version)} is not semver`);
  else if (tag !== `v${pkg.version}`) found.push(`tag ${JSON.stringify(tag)} does not match package version v${pkg.version}`);

  const slug = repositorySlug(pkg.repository);

  if (!repository) found.push('--repository is required');
  else if (slug?.toLowerCase() !== repository.toLowerCase()) found.push(`package repository ${JSON.stringify(slug ?? null)} does not match ${repository}`);

  const target = pkg.publishConfig?.registry;

  if (target !== undefined && trimSlash(target) !== trimSlash(registry)) found.push(`publishConfig.registry is ${target}, expected ${registry}`);

  return found;
}

const { values } = parseArgs({ options: { tag: { type: 'string' }, repository: { type: 'string' } } });

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

const found = problems(pkg, values.tag ?? '', values.repository ?? '');

for (const problem of found) console.error(`check-release: ${problem}`);

if (found.length) process.exitCode = 1;
else console.log(`release ok: ${pkg.name}@${pkg.version} from ${values.repository}`);
