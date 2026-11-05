---
description: Records why Pi opens the studio with a /studio command that starts or reuses a detached instance for the current project.
---

# ADR-0008: Pi integration through `/studio`

This decision connects Pi to the studio. The [architecture](../../architecture.md#studio-from-pi) shows the flow. Instance is defined in the [domain language](../../CONTEXT.md).

> **Quick Reference** | Status: Accepted | Date: 2026-10-04
> **Decision**: `/studio` opens the studio for the folder Pi works in. The studio runs as a detached instance that outlives the Pi session, and `/studio stop` ends it.
> **Context**: A separate web app started with `npm start -- --project ...` made you leave Pi to use it.
> **Alternatives**: A shell command only; stop the studio when the Pi session ends
> **Impact**: `pi/extension.ts`, `pi/studio.ts`, `bin/instances.ts`, `bin/cli.ts` (`open`, `stop`)

---

## Context

Using the studio on a real project meant leaving Pi, finding the folder and starting a server. Several Pi sessions often work in the same project, and each one would start its own server.

## Decision

**`/studio` opens the studio for the folder Pi works in.** It calls `startInstance` in `bin/instances.ts`. A live instance for that project is reused. Otherwise it takes a lock, spawns a detached server, waits for its URL and records it in a state file. `/studio all` opens the all-projects view. `/studio stop` stops the instance.

**The instance is detached.** It keeps running after Pi quits, and there is no `session_shutdown` handler. The CLI's `open` and `stop` commands use the same instance records.

**The studio refuses to open its own repository or `fixtures/` as a project.** The extension shows that error and opens nothing.

## Alternatives considered

| Option | Pros | Cons | Why not |
| --- | --- | --- | --- |
| A shell command only | No Pi dependency | You leave Pi to open it | The slash command keeps you in Pi |
| Stop on `session_shutdown` | No idle studios | One session can stop a studio another session uses | Shared instances must outlive one session |

## Consequences

- **Positive**: links, menus and other Pi sessions share one studio per project.
- **Negative**: studios keep running until `/studio stop` or a reboot.
- **Requires**: `pi/` imports no Pi package, so Pi stays a host, not a dependency. `test/pi-extension.test.js` pins the detached behaviour.

## Related

[ADR-0004](./ADR-0004-local-server-security.md) sets the token every instance starts with.
