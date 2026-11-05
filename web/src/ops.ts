// The edits the canvas, the inspector and the CLI make: one implementation, in shared/ops.ts. This file only types it.
import * as shared from "../../shared/ops.ts";
import type { Field, Kind, Machine, State } from "./types.ts";

type Ops = {
  slug: (s: string) => string;
  /** A new task after `from`, entered by an event named for leaving it. A fanout keeps its one event, re-pointed. */
  addAfter: (m: Machine, from: string, role?: string) => { m: Machine; id: string; event: string };
  eventNameFor: (m: Machine, from: string, to: string) => string;
  connect: (m: Machine, from: string, to: string, event: string) => Machine;
  retitle: (m: Machine, id: string, title: string) => Machine;
  removeState: (m: Machine, id: string) => { m: Machine; removed: string[] };
  renameState: (m: Machine, from: string, to: string) => Machine;
  addState: (m: Machine, role?: string) => { m: Machine; id: string };
  setKind: (s: State, kind: Kind, role?: string) => State;
  clean: (m: Machine) => Machine;
  setField: (m: Machine, state: string, key: "title" | "role" | "kind" | "prompt" | "maxVisits" | "outcome", value: unknown) => Machine;
  setInput: (m: Machine, name: string, field: Field) => Machine;
  removeInput: (m: Machine, name: string) => Machine;
  setOutput: (m: Machine, state: string, name: string, field: Field) => Machine;
  removeOutput: (m: Machine, state: string, name: string) => Machine;
  setEvent: (m: Machine, from: string, event: string, t: { to: string; description?: string }) => Machine;
  removeEvent: (m: Machine, from: string, event: string) => Machine;
};
const ops = shared as unknown as Ops;

export const { slug, addAfter, eventNameFor, connect, retitle, removeState, renameState, addState, setKind, clean, setField, setInput, removeInput, setOutput, removeOutput, setEvent, removeEvent } = ops;
