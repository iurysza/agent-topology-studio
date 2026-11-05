// Runs before npm install on a fresh clone, so it must import nothing outside node:.
// Walks flags left to right. --help returns at once, before the cross-flag checks.

type Flags = { help: false; open: boolean; noToken: boolean; apiOnly: boolean; all: boolean; project?: string; runsFrom?: string; devToken?: string; publicOrigin?: string };

type Parsed = Flags & { port: number };

/** The parsed flags. --help returns only { help: true }, so its other fields are absent. */
export type ServerArgs = Parsed | { help: true } & { [K in Exclude<keyof Parsed, 'help'>]?: undefined };

type ValueKey = 'project' | 'runsFrom' | 'port' | 'devToken' | 'publicOrigin';

const valueKeys = { '--project': 'project', '--runs-from': 'runsFrom', '--port': 'port', '--dev-token': 'devToken', '--public-origin': 'publicOrigin' } satisfies Record<string, ValueKey>;

export function parseServerArgs(argv: readonly string[]): ServerArgs {
  // port holds the raw flag text until the range check below.
  const options: Flags & { port: number | string } = { help: false, port: 0, open: true, noToken: false, apiOnly: false, all: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--no-token') { options.noToken = true; continue; }

    if (flag === '--help') return { help: true };

    if (flag === '--no-open') { options.open = false; continue; }

    if (flag === '--api-only') { options.apiOnly = true; continue; }

    if (flag === '--all') { options.all = true; continue; }

    // SAFETY: an unknown flag gives undefined and fails the check below. Like the old object lookup, an
    // Object.prototype name such as toString gives a function, which is truthy and becomes a string key.
    const key = valueKeys[flag as keyof typeof valueKeys];
    if (!key || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Invalid or missing argument: ${flag}`);
    options[key] = argv[++i];
  }

  if (!options.project && !options.all) throw new Error('--project <dir> is required');

  if (options.all && options.runsFrom) throw new Error('--runs-from cannot be used with --all');

  if (options.noToken && options.devToken) throw new Error('--no-token and --dev-token are exclusive');

  if (options.devToken && options.open) throw new Error('--dev-token requires --no-open');

  if (options.publicOrigin !== undefined) {
    if (!options.noToken) throw new Error('--public-origin requires --no-token');
    options.publicOrigin = parsePublicOrigin(options.publicOrigin);
  }

  const port = Number(options.port); if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be 0 to 65535');
  return { ...options, port };
}

/**
 * The canonical origin for --public-origin, such as https://studio.example.test. Throws on anything else.
 * Only http or https, a host and an optional port, and at most a trailing slash: no credentials, path, query,
 * fragment or wildcard. Case and a default port are normalised the way a browser writes the Origin header.
 */
function parsePublicOrigin(text: string): string {
  const invalid = new Error(`--public-origin must be an origin such as https://studio.example.test, not ${JSON.stringify(text)}`);

  if (!/^https?:\/\/[^/?#@*\\\s]+\/?$/i.test(text)) throw invalid;

  let url: URL;

  try { url = new URL(text); } catch { throw invalid; }

  if (!['http:', 'https:'].includes(url.protocol) || url.hostname === '' || url.origin === 'null' || url.origin.includes('*')) throw invalid;

  return url.origin;
}
