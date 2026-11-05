// The machine, as spec section 1 defines it. The server owns the rules; these types are the web's view of them.
export type FieldType = "string" | "number" | "boolean" | "array" | "object";
export interface Field { type: FieldType; required?: boolean; description?: string; default?: unknown }
export interface Transition { to: string; description?: string }
export interface Branch { id: string; role: string; prompt: string }
export type Kind = "task" | "decision" | "fanout" | "final";
export interface State {
  kind: Kind; title: string;
  role?: string; prompt?: string; output?: Record<string, Field>;
  branches?: Branch[];
  on?: Record<string, Transition>;
  maxVisits?: number;
  outcome?: "success" | "failure";
}
export interface Machine {
  id: string; name: string; description: string; whenToUse?: string;
  inputs?: Record<string, Field>; initial: string; states: Record<string, State>;
}
/** A role is an agent file in .pi/agents. `color` is the Pi name as written (blue, cyan, green, magenta, orange, purple, red, yellow). */
export interface Role { name: string; description?: string | null; color?: string | null; model?: string | null; thinking?: string | null; tools?: string[]; skills?: string[] }
export interface RoleFile { role: Role; body: string; hash: string }
export interface WorkflowSummary { id: string; name: string; description?: string; editable: boolean; states?: number; machine?: Machine }
export interface Project { dir: string; roles: Role[]; workflows: WorkflowSummary[]; name?: string; branch?: string | null }
export interface Loaded { machine: Machine; code: string; hash: string; problems: string[]; warnings: string[] }
/** One project in all projects mode, as GET /api/projects lists it (server/registry.ts). */
export interface ProjectEntry { id: string; root: string; name: string; workflows: number; lastRunAt: string | null; source: "session" | "config" | "cli" }
