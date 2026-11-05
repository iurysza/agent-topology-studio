import type { Json } from '../shared/replay.ts';
import { RoleError } from './errors.ts';

export { RoleError } from './errors.ts';

type TextField = 'description' | 'color' | 'model' | 'thinking';

type ListField = 'tools' | 'skills';

type Field = TextField | ListField;

/** A name that isRoleName accepted. The brand stops the guard's false branch from narrowing a string to never. */
export type RoleName = string & { readonly roleName: true };

/** A role as read from its frontmatter. A missing text field is null; a missing list is empty. */
export type RoleRecord = { name: string } & { [K in TextField]: string | null } & { [K in ListField]: string[] };

/** A role file split into its record and the text after the frontmatter. */
export type RoleFile = { role: RoleRecord; body: string };

const fields: readonly Field[] = ['description', 'color', 'model', 'thinking', 'tools', 'skills'];
export const roleListFields: readonly Field[] = ['tools', 'skills'];
const frontmatter = (code: string) => code.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
export const isRoleName = (name: unknown): name is RoleName => typeof name === 'string' && /^[a-z][a-z0-9-]*$/.test(name);
const isListField = (key: Field): key is ListField => roleListFields.includes(key);

function valueOf(header: string, key: Field): string | null {
  // exec gives the same match as a non-global String.prototype.match, and types index as a number.
  const match = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(header);
  if (!match) return null;

  const value = match[1].trim();
  if (/^[>|][-+]?\s*$/.test(value)) {
    const lines = header.slice(match.index + match[0].length).match(/^(?:\r?\n[ \t]+[^\r\n]*)+/)?.[0];
    return lines ? lines.trim().split(/\r?\n/).map(line => line.trim()).join(value[0] === '>' ? ' ' : '\n') : null;
  }

  if (value.startsWith('"')) { try { const parsed: Json = JSON.parse(value); return typeof parsed === 'string' ? parsed : null; } catch { return null; } }

  if (value.startsWith("'")) return value.endsWith("'") ? value.slice(1, -1).replace(/''/g, "'") : null;

  return value.replace(/\s+#.*$/, '').trim() || null;
}

export function roleRecord(name: string, code: string): RoleFile {
  const front = frontmatter(code), role: RoleRecord = { name, description: null, color: null, model: null, thinking: null, tools: [], skills: [] };
  for (const key of fields) {
    const value = valueOf(front?.[1] ?? '', key);
    if (isListField(key)) role[key] = (value ?? '').split(',').map(item => item.trim()).filter(Boolean);
    else role[key] = value;
  }

  return { role, body: front ? code.slice(front[0].length) : code };
}

// values and body arrive as parsed JSON from the HTTP API, so they are checked here before use.
export function roleCode(code: string | null, values: Json | undefined, body: Json | undefined): string {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new RoleError({ message: 'frontmatter must be an object' });

  if (typeof body !== 'string') throw new RoleError({ message: 'body must be a string' });

  let header = frontmatter(code ?? '')?.[1].replace(/\r\n/g, '\n') ?? '';
  for (const [key, value] of Object.entries(values)) {
    if (!isField(key)) throw new RoleError({ message: `Unknown frontmatter field: ${key}` });

    const list = roleListFields.includes(key);
    if (value !== null && (list ? !Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim() || /[,\r\n]/.test(item)) : typeof value !== 'string')) throw new RoleError({ message: `${key} must be ${list ? 'an array of names' : 'a string'}` });
  }

  for (const key of fields) {
    if (!Object.hasOwn(values, key)) continue;

    const value = values[key], list = roleListFields.includes(key);
    const pattern = new RegExp(`^${key}:[^\\n]*(?:\\n[ \\t]+[^\\n]*)*`, 'm');
    // The loop above checked every entry: a list value is an array of strings here, and a text value is a string.
    const line = value === null ? '' : `${key}: ${JSON.stringify(list && Array.isArray(value) ? value.join(', ') : value)}`;
    if (pattern.test(header)) header = header.replace(pattern, () => line);
    else if (line) header += `${header ? '\n' : ''}${line}`;
  }

  return `---\n${header}\n---\n${body}`;
}

function isField(key: string): key is Field {
  return fields.some(field => field === key);
}
