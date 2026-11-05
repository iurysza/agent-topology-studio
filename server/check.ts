import { parse } from 'acorn';
import type { ExportNamedDeclaration, Position, Program, VariableDeclaration } from 'acorn';
import { literal } from '../shared/literal.ts';
import type { LiteralValue } from '../shared/literal.ts';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { messageOf } from './narrow.ts';

/**
 * The meta literal as read from workflow code. It is not validated yet, so every value is any literal.
 * checkWorkflowCode checks it.
 */
export type WorkflowMeta = { [key: string]: LiteralValue };

/** A name that isSafeName accepted. The brand stops the guard's false branch from narrowing a string to never. */
export type SafeName = string & { readonly safeName: true };

/** errors holds undefined where a caught value had no string message, as the old e.message did. */
export type CheckResult = { errors: (string | undefined)[]; warnings: string[]; meta: WorkflowMeta | null };

export type CheckOptions = { readonly fileName?: string };

type MetaDeclaration = { exp: ExportNamedDeclaration; declaration: VariableDeclaration; meta: WorkflowMeta };

// acorn's SyntaxError carries its position as loc.
type Located = { readonly loc: Position };

// vm.Script throws a SyntaxError with a stack.
type Stacked = { readonly stack: string };

const isLocated = (cause: unknown): cause is Located => typeof cause === 'object' && cause !== null && 'loc' in cause && typeof cause.loc === 'object' && cause.loc !== null;

const isStacked = (cause: unknown): cause is Stacked => typeof cause === 'object' && cause !== null && 'stack' in cause && typeof cause.stack === 'string';

const isTitled = (phase: LiteralValue): phase is { readonly title: string } => typeof phase === 'object' && phase !== null && !Array.isArray(phase) && typeof phase.title === 'string';

// The TypeError V8 gives when the old code read `outer.inner` and `outer` was missing: null or undefined for outer, else undefined for inner.
const readFailure = (cause: unknown, outer: string, inner: string) => cause === null || cause === undefined
  ? new TypeError(`Cannot read properties of ${cause === null ? 'null' : 'undefined'} (reading '${outer}')`)
  : new TypeError(`Cannot read properties of undefined (reading '${inner}')`);

export const isSafeName = (name: unknown): name is SafeName => typeof name === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(name) && name !== '.' && name !== '..';

export const hashText = (text: string): string => createHash('sha256').update(text).digest('hex');

const parseJs = (code: string): Program => parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, locations: true });

function metaDeclaration(ast: Program): MetaDeclaration {
  const exports = ast.body.filter(n => n.type.startsWith('Export'));
  if (exports.length !== 1) throw new Error('Exactly one export is required: export const meta = {...}');
  const exp = exports[0], d = 'declaration' in exp ? exp.declaration : undefined;
  if (exp.type !== 'ExportNamedDeclaration' || d?.type !== 'VariableDeclaration' || d.kind !== 'const' || d.declarations.length !== 1 || d.declarations[0].id.type !== 'Identifier' || d.declarations[0].id.name !== 'meta' || d.declarations[0].init?.type !== 'ObjectExpression') throw new Error('Expected export const meta = {...}');
  // SAFETY: literal() of an ObjectExpression returns a plain object or throws. Its values are unvalidated; checkWorkflowCode checks them.
  return { exp, declaration: d, meta: literal(d.declarations[0].init) as WorkflowMeta };
}

export function extractMeta(code: string): WorkflowMeta | null {
  try { return metaDeclaration(parseJs(code)).meta; } catch { return null; }
}

export function checkWorkflowCode(code: string, { fileName = 'workflow.js' }: CheckOptions = {}): CheckResult {
  const errors: (string | undefined)[] = [], warnings: string[] = []; let meta: WorkflowMeta | null = null;
  const result = (): CheckResult => ({ errors, warnings, meta });
  if (typeof code !== 'string') { errors.push('Code must be a string'); return result(); }
  if (code.length > 524288) errors.push(`Script size limit is 524288 characters; received ${code.length}`);
  // oxlint-disable-next-line no-control-regex -- rejects control characters on purpose
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(code)) errors.push('Script contains a control character');
  if (errors.length) return result();
  let ast: Program;
  try { ast = parseJs(code); } catch (e) {
    if (!isLocated(e)) throw readFailure(e, 'loc', 'line');
    errors.push(`Syntax error at line ${e.loc.line}, column ${e.loc.column + 1}: ${messageOf(e)}`); return result();
  }
  if (ast.body.some(n => n.type === 'ImportDeclaration')) errors.push('Imports are not allowed');
  let exp: ExportNamedDeclaration, declaration: VariableDeclaration;
  try { ({ exp, declaration, meta } = metaDeclaration(ast)); } catch (e) { errors.push(messageOf(e)); return result(); }
  for (const key of ['name', 'description']) if (typeof meta[key] !== 'string' || !meta[key].trim()) errors.push(`meta.${key} must be a non-empty string`);
  if (meta.phases !== undefined && (!Array.isArray(meta.phases) || meta.phases.some(p => !p || !isTitled(p)))) errors.push('meta.phases must be an array of objects with a string title');
  if (meta.name && meta.name !== fileName.replace(/\.js$/, '') && fileName !== 'workflow.js') warnings.push(`meta.name ${meta.name} differs from file name ${fileName}`);
  const body = code.slice(0, exp.start) + ' '.repeat(declaration.start - exp.start) + code.slice(declaration.start);
  try { new vm.Script(`(async (agent, phase, log, workflow, console, args) => {const Date = globalThis.Date;\n${body}\n})`, { filename: fileName, lineOffset: -1 }); }
  catch (e) {
    if (!isStacked(e)) throw readFailure(e, 'stack', 'split');
    errors.push(`V8 compile error: ${e.stack.split('\n').slice(0, 5).join('\n')}`);
  }
  return result();
}
