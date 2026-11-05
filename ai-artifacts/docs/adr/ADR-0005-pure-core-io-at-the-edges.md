---
description: Records why shared/ is a pure core, IO lives only at named edges, Effect stays in server/, and caught values go through narrow.ts.
---

# ADR-0005: Pure core, IO at the edges, Effect only in `server/`

This decision sets the module boundaries in the [architecture](../../architecture.md#component-boundaries). Lint and a test enforce it.

> **Quick Reference** | Status: Accepted | Date: 2026-10-24
> **Decision**: `shared/` imports no Node built-ins, no `effect` and no server code. IO lives only in server/, bin/, pi/, scripts/ or web/src/api.ts. `effect` is imported only under `server/`. Caught values are read through `server/narrow.ts`.
> **Context**: The runner in `shared/` is embedded in every workflow file and the web app ships as a browser bundle, so both must stay small and free of IO.
> **Alternatives**: Allow `node:path` in `shared/`; Effect everywhere; ad hoc `instanceof Error` checks
> **Impact**: `shared/`, `server/`, `web/src`, `oxlint.config.ts`, `test/effect-fence.test.js`

---

## Context

`shared/` holds the machine compiler, the runner and replay. The server, the CLI and the web app all import it, and the runner string ends up in every workflow file. It leaked once: a session-path helper imported `node:path`.

Effect gives typed services and failures for file IO. In the embedded runner or the browser bundle it would cost the most and help the least.

Strict TypeScript makes a `catch` variable `unknown`. The old code read `e.message`, `e.code` and `e.hint` directly. A converted catch site must keep the same values.

## Decision

**`shared/` is pure: no Node built-ins, no `effect` and no `server/` imports.** IO lives only at the edges: server/, bin/, pi/, scripts/ or web/src/api.ts. That list is written once, in the lint message in `oxlint.config.ts`. Code that needs a file or a path lives at an edge and passes data in. The session-path helper moved to `server/session-paths.ts`. Only the pure `encodeCwd` stayed in `shared/`.

**`effect` is imported only under `server/`.** `shared/`, `web/src`, `bin/`, `pi/` and `scripts/` stay Effect-free. `runEdge` in `server/edge.ts` is the one place server code runs an Effect.

**Caught values are read through `server/narrow.ts`.** It exports `isErrno`, `isHinted`, `messageOf` and `isAddressInfo`. `messageOf` returns the message string or `undefined`, which equals the old `e.message` read for every Error, primitive and plain object. `.catch(...)` callbacks name their parameter `cause: unknown`.

## Alternatives considered

| Option | Pros | Cons | Why not |
| --- | --- | --- | --- |
| Allow `node:path` in `shared/` | Cheap | The rule gets an exception | A rule with an exception does not survive |
| Inject `path.join` into the helper | Keeps it in place | A server-only function stays in the core | The function belongs at the edge |
| Effect everywhere | One error model | Bloats the runner and the browser bundle | Cost without benefit there |
| `e instanceof Error ? e.message : String(e)` | Common idiom | Gives `'x'` where old code gave `undefined` for `throw 'x'` | Changes CLI output |

## Consequences

- **Positive**: core logic is tested with plain inputs and outputs. The runner and the browser bundle carry no Effect code. One module defines how an open value is read.
- **Negative**: code that needs a file must sit at an edge. Effect-style error handling stops at the server.
- **Requires**: the `shared/**` and `web/**` lint overrides and `test/effect-fence.test.js` stay green. A new edge directory or a new Effect import outside `server/` needs a new ADR.

## Related

[ADR-0006](./ADR-0006-typescript-and-dist-packaging.md) is the strict TypeScript move that made `narrow.ts` necessary. [ADR-0007](./ADR-0007-tests-prove-behaviour.md) covers the lint plugin that holds these rules.
