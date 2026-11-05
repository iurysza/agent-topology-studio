import { parse } from 'acorn';
// SAFETY: the constructor of an async function is AsyncFunction, which builds async functions from source strings.
const AsyncFunction = /** @type {new (...params: string[]) => (...args: unknown[]) => Promise<unknown>} */ ((async function () {}).constructor);
function assertDefined(value, at = 'agent() opts') {
  if (value === undefined) throw new Error(`Cannot pass undefined across the workflow VM boundary (at ${at})`);
  if (value !== null && typeof value === 'object') for (const [key, item] of Object.entries(value)) assertDefined(item, `${at}.${key}`);
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// Mirrors valid() in shared/replay.ts. Kept in test code so it does not become public API.
function matchesSchema(value, schema) {
  if (!object(value)) return false;
  if ((schema.required ?? []).some(key => !Object.hasOwn(value, key))) return false;
  return Object.entries(schema.properties ?? {}).every(([key, field]) => {
    if (!Object.hasOwn(value, key)) return true;
    const item = value[key];
    const typeOK = field.type === 'object' ? object(item) : field.type === 'array' ? Array.isArray(item) : typeof item === field.type && (field.type !== 'number' || Number.isFinite(item));
    return typeOK && (!field.enum || field.enum.includes(item));
  });
}
// malformed: 'reject' (default) fails the run on any answer that breaks its schema,
// 'null' turns such an answer into null like the upstream host, 'pass' hands it through unchanged.
// A null answer is the host's own failure signal, so it is never a schema violation.
/**
 * @param {string} code
 * @param {{ agent?: (prompt: string, options: any) => any, args?: object, phase?: (...a: any[]) => void, log?: (...a: any[]) => void, gateFails?: boolean, malformed?: 'reject' | 'null' | 'pass' }} [options]
 * @returns {Promise<any>}
 */
export async function runWorkflow(code, { agent, args = {}, phase = () => {}, log = () => {}, gateFails = false, malformed = 'reject' } = {}) {
  if (!['reject', 'null', 'pass'].includes(malformed)) throw new Error(`Unknown malformed mode: ${malformed}`);
  const ast = parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true });
  const exp = ast.body.find(/** @returns {node is import('acorn').ExportNamedDeclaration & { declaration: import('acorn').VariableDeclaration }} */ node => node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'VariableDeclaration' && node.declaration.declarations[0]?.id.type === 'Identifier' && node.declaration.declarations[0].id.name === 'meta');
  if (!exp) throw new Error('Workflow needs export const meta');
  const body = code.slice(0, exp.start) + ' '.repeat(exp.declaration.start - exp.start) + code.slice(exp.declaration.start);
  const parallel = thunks => Promise.all(thunks.map(thunk => Promise.resolve().then(thunk).catch(() => null)));
  const pipeline = (items, ...stages) => parallel(items.map((item, index) => async () => {
    let previous = item;
    for (const stage of stages) previous = await stage(previous, item, index);
    return previous;
  }));
  const assertions = [], violations = [];
  const gatedAgent = async (prompt, options) => {
    assertDefined(options);
    let result;
    try { result = await agent(prompt, options); }
    catch (error) { if (error?.code === 'ERR_ASSERTION') assertions.push(error); throw error; }
    if (options.schema && malformed !== 'pass' && result !== null && !matchesSchema(result, options.schema)) {
      if (malformed === 'reject') violations.push(`Fake host: ${options.label} answered ${JSON.stringify(result) ?? String(result)}, which does not match its schema`);
      else result = null;
    }
    if (options.gate && gateFails) throw new Error(`Gate failed: ${options.gate}\nTest command exited 1`);
    return result;
  };
  const result = await new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', body)(gatedAgent, parallel, pipeline, phase, log, args);
  if (assertions.length) throw assertions[0];
  if (violations.length) throw new Error(violations.join('\n'));
  return result;
}
