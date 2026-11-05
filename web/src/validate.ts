// One validator: the shared one the server uses, so the editor's problems are the ones save would refuse.
import { validateMachine as untyped } from "../../shared/machine.ts";
import type { Machine, Role } from "./types.ts";

// shared/machine.js is plain JS; its `roles = null` default would otherwise type the option as null only.
const validateMachine = untyped as (m: unknown, o: { roles: Role[] | null; fileName?: string }) => { problems: string[]; warnings: string[] };

export function validate(m: Machine, roles?: Role[]): { problems: string[]; warnings: string[] } {
  return validateMachine(m, { roles: roles ?? null, fileName: `${m.id}.js` });
}

/** The state ids a problem line names (`State \`build\` …`), so the graph and the list can mark them. */
export const namedStates = (p: string) => [...p.matchAll(/State `([a-z][a-z0-9_]*)`/g)].map((x) => x[1]);
