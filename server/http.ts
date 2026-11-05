import http from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { validateMachine, compile, extract, templateMachine } from '../shared/machine.ts';
import { checkWorkflowCode, isSafeName } from './check.ts';
import { RequestError } from './errors.ts';
import { errorResponse } from './http-errors.ts';
import { isProjectId } from './registry.ts';
import type { ProjectList } from './registry.ts';
import { isAddressInfo, isErrno, messageOf } from './narrow.ts';
import type { IncomingMessage } from 'node:http';
import type { Machine } from '../shared/machine.ts';
import type { Json, JsonObject } from '../shared/replay.ts';
import type { CheckResult } from './check.ts';
import type { Project } from './project.ts';

/** compiled's result: no code when validation fails, else the code and the checker's problems. */
type Compiled = { code: null; problems: string[]; warnings: string[] } | { code: string; problems: CheckResult['errors']; warnings: string[] };

const missing: (string | undefined)[] = ['ENOENT', 'EISDIR', 'ENOTDIR'];

/** The registry calls the server makes in all projects mode. */
type Registry = { list(): Promise<ProjectList>; open(id: string): Promise<Project | null> };

/** A single project, or all projects through a registry. In all projects mode project is unused and may be null. */
type ServerOptions = { token: string | null; webRoot: string | null; publicOrigin?: string | null } & ({ project: Project; registry?: null } | { project: Project | null; registry: Registry });

async function jsonBody(req: IncomingMessage): Promise<JsonObject> {
  let size = 0, chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2097152) throw new RequestError({ status: 413, message: 'JSON body exceeds 2097152 bytes' });
    chunks.push(chunk);
  }
  try { const body: Json = JSON.parse(Buffer.concat(chunks).toString() || '{}'); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); return body; }
  catch { throw new RequestError({ status: 400, message: 'Expected a JSON object' }); }
}
/** application/json in any case, with optional well-formed parameters such as `; charset="utf-8"`. */
const jsonType = /^\s*application\/json\s*(?:;\s*[!#$%&'*+.^_`|~0-9a-z-]+=(?:[!#$%&'*+.^_`|~0-9a-z-]+|"(?:[^"\\]|\\.)*")\s*)*$/i;

/**
 * Tokenless mode has no secret, so a write must come from the studio's own page or a client that is not a browser.
 * Fetch metadata other than same-origin or none is refused. A present Origin must be one of the allowed origins.
 * No Origin and no cross-site metadata is a CLI or script. X-Forwarded-* and Forwarded are never read.
 * Body-bearing writes must be JSON: text/plain and form posts are what a foreign page can send without a preflight.
 */
function refuseWrite(req: IncomingMessage, allowed: readonly string[]): { status: number; error: string } | null {
  const site = req.headers['sec-fetch-site'];

  if (site !== undefined && site !== 'same-origin' && site !== 'none') return { status: 403, error: 'Cross-site request refused' };

  const origin = req.headers.origin;

  if (origin !== undefined && !allowed.includes(origin)) return { status: 403, error: 'Origin not allowed' };

  if (['POST', 'PUT', 'PATCH'].includes(req.method ?? '') && !jsonType.test(req.headers['content-type'] ?? '')) return { status: 415, error: 'Content-Type must be application/json' };

  return null;
}

/** True for an exact http(s) origin as a browser writes it: no path, credentials, wildcard or trailing slash. */
function isCanonicalOrigin(text: string): boolean {
  if (text.includes('*')) return false;

  let url: URL;

  try { url = new URL(text); } catch { return false; }

  return ['http:', 'https:'].includes(url.protocol) && url.origin === text;
}

export function createServer({ project: base, token, webRoot, registry, publicOrigin = null }: ServerOptions) {
  // Fail closed: only a canonical origin such as https://studio.example.test may be allowed. args.ts checks it first.
  if (publicOrigin !== null && !isCanonicalOrigin(publicOrigin)) throw new TypeError(`publicOrigin must be a canonical origin, not ${JSON.stringify(publicOrigin)}`);

  const server = http.createServer(async (req, res) => {
    // Per request: in all projects mode each request rebinds its own project. Never reassign the closure variable.
    let project: Project;
    const send = <B>(status: number, body: B) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    try {
      const address = server.address();
      if (address === null) return send(503, { error: 'Starting' });
      const port = isAddressInfo(address) ? address.port : undefined;
      const hosts: (string | undefined)[] = [ `127.0.0.1:${port}`, `localhost:${port}` ];
      if (!hosts.includes(req.headers.host)) return send(403, { error: 'Invalid Host' });
      const rawPath = (req.url ?? '/').split('?')[0];
      let pathname: string; try { pathname = decodeURIComponent(rawPath); } catch { throw new RequestError({ status: 400, message: 'Invalid URL' }); }
      if (!pathname.startsWith('/api/')) {
        if (webRoot === null) return send(404, { error: 'Not found' });
        if (req.method !== 'GET') return send(404, { error: 'Not found' });
        const root = await realpath(webRoot), candidate = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
        if (!candidate.startsWith(root + path.sep) || pathname.split('/').includes('..')) return send(404, { error: 'Not found' });
        try {
          const resolved = await realpath(candidate); if (!resolved.startsWith(root + path.sep)) return send(404, { error: 'Not found' });
          const content = await readFile(resolved), ext = path.extname(resolved);
          // A Map, not an object literal, gives the same lookups: extname is '' or starts with '.', and no Object.prototype key does.
          const types = new Map([['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'], ['.css', 'text/css; charset=utf-8'], ['.svg', 'image/svg+xml'], ['.woff2', 'font/woff2']]);
          res.writeHead(200, { 'Content-Type': types.get(ext) ?? 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=31536000, immutable' }); return res.end(content);
        } catch (e) { if (isErrno(e) && missing.includes(e.code)) return send(404, { error: 'Not found' }); throw e; }
      }
      if (token !== null) {
        const supplied = Buffer.from(String(req.headers['x-studio-token'] ?? '')), expected = Buffer.from(token);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return send(401, { error: 'Invalid token' });
      } else if (req.method !== 'GET' && req.method !== 'HEAD') {
        const refused = refuseWrite(req, [`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...(publicOrigin === null ? [] : [publicOrigin])]);

        if (refused) return send(refused.status, { error: refused.error });
      }
      if (registry) {
        if (pathname === '/api/projects') {
          if (req.method !== 'GET') return send(405, { error: 'Method not allowed' });
          return send(200, await registry.list());
        }
        const scoped = pathname.match(/^\/api\/p\/([^/]+)(\/.*)$/);
        if (!scoped) return send(404, { error: 'Not found' });
        if (!isProjectId(scoped[1])) throw new RequestError({ status: 400, message: 'Invalid project id' });
        const opened = await registry.open(scoped[1]);
        if (!opened) throw new RequestError({ status: 404, message: 'Project not found' });
        project = opened;
        pathname = '/api' + scoped[2];
      } else project = base;
      if (pathname === '/api/runs' && req.method === 'GET') return send(200, { runs: await project.listRuns(new URL(req.url ?? '/', 'http://localhost').searchParams.get('workflow') ?? undefined) });
      if (pathname.startsWith('/api/runs/')) {
        if (req.method !== 'GET') return send(405, { error: 'Method not allowed' });
        const run = await project.readRun(pathname.slice('/api/runs/'.length));
        if (!run) throw new RequestError({ status: 404, message: 'Run not found' });
        return send(200, run);
      }
      if (pathname === '/api/catalog') {
        if (req.method !== 'GET') return send(405, { error: 'Method not allowed' });
        return send(200, await project.catalog());
      }
      if (pathname === '/api/project' && req.method === 'GET') return send(200, { dir: project.root, workflows: await project.listWorkflows(), roles: await project.listRoles(), name: project.name, branch: (await project.branch?.()) ?? null });
      if (pathname === '/api/roles' && req.method === 'POST') return send(201, await project.createRole(await jsonBody(req)));
      const roleMatch = pathname.match(/^\/api\/roles\/([^/]+)$/);
      if (roleMatch) {
        const name = roleMatch[1], loaded = await project.readRole(name);
        if (!loaded) throw new RequestError({ status: 404, message: 'Role not found' });
        if (req.method === 'GET') return send(200, loaded);
        if (req.method !== 'PUT') return send(405, { error: 'Method not allowed' });
        const body = await jsonBody(req);
        if (typeof body.baseHash !== 'string') throw new RequestError({ status: 400, message: 'baseHash is required' });
        return send(200, await project.writeRole(name, body.frontmatter, body.body, body.baseHash));
      }
      const roles = await project.listRoles();
      function compiled(machine: Json | Machine, fileName?: string): Compiled {
        const issues = validateMachine(machine, { roles, fileName });
        if (issues.problems.length) return { code: null, ...issues };
        // SAFETY: validateMachine found no problems, so machine has every field compile reads.
        const code = compile(machine as Machine), checked = checkWorkflowCode(code, { fileName });
        return { code, problems: checked.errors, warnings: [...issues.warnings, ...checked.warnings] };
      }
      async function loaded(id: string) {
        const { code, sha256: hash } = await project.readScript(id);
        if (code === null) throw new RequestError({ status: 404, message: 'Workflow not found' });
        const machine = extract(code);
        if (machine === null) { send(409, { error: 'This hand-written workflow has no machine literal and is not editable.', code }); return null; }
        return { machine, code, hash, ...validateMachine(machine, { roles, fileName: `${id}.js` }) };
      }
      if (pathname === '/api/compile' && req.method === 'POST') {
        const body = await jsonBody(req); return send(200, compiled(body.machine));
      }
      if (pathname === '/api/workflows' && req.method === 'POST') {
        const body = await jsonBody(req), id = body.id;
        if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id) || !isSafeName(id)) throw new RequestError({ status: 400, message: 'Invalid workflow id' });
        const result = compiled(templateMachine(id), `${id}.js`);
        if (result.problems.length) return send(422, { problems: result.problems });
        // SAFETY: compiled gives a null code only with problems, and there are none here.
        await project.writeScript(id, result.code as string, null);
        return send(201, await loaded(id));
      }
      const match = pathname.match(/^\/api\/workflows\/([^/]+)$/);
      if (!match) return send(404, { error: 'Not found' });
      const id = match[1]; if (!isSafeName(id)) throw new RequestError({ status: 400, message: 'Invalid workflow id' });
      if (req.method === 'GET') { const result = await loaded(id); if (result) send(200, result); return; }
      if (req.method === 'DELETE') {
        if (!await project.deleteScript(id)) throw new RequestError({ status: 404, message: 'Workflow not found' });
        return send(200, {});
      }
      if (req.method !== 'PUT') return send(405, { error: 'Method not allowed' });
      const body = await jsonBody(req), result = compiled(body.machine, `${id}.js`);
      if (result.problems.length) return send(422, { problems: result.problems });
      if (typeof body.hash !== 'string') throw new RequestError({ status: 400, message: 'hash is required' });
      const current = await loaded(id); if (!current) return;
      // SAFETY: compiled gives a null code only with problems, and there are none here.
      const hash = await project.writeScript(id, result.code as string, body.hash);
      return send(200, { code: result.code, hash, warnings: result.warnings });
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      const mapped = errorResponse(e);
      if (mapped) send(mapped.status, mapped.body);
      else { console.error(e); send(500, { error: 'Server error', detail: messageOf(e) }); }
    }
  });
  server.requestTimeout = 0; server.headersTimeout = 120000;
  return server;
}
