---
description: Records how the local server guards its API, what tokenless mode allows, and why clients send project ids instead of paths.
---

# ADR-0004: Local server security

This decision guards the HTTP API in `server/http.ts`, shown in the [component boundaries](../../architecture.md#component-boundaries). Project id and all-projects mode are defined in the [domain language](../../CONTEXT.md).

> **Quick Reference** | Status: Accepted | Date: 2026-10-24
> **Decision**: The server binds 127.0.0.1 and checks a fresh token on every API call. `--no-token` drops the token for private networks and then requires an allowed origin and JSON for writes. In all-projects mode, clients send a project id, never a path.
> **Context**: The API reads and writes workflow files, so a stray web page or request must not reach it.
> **Alternatives**: Always require a token; trust `Sec-Fetch-Site` alone; let clients send project paths
> **Impact**: `server/http.ts`, `server/registry.ts`, `bin/studio.ts` flags, `reference/cli.md`

---

## Context

The studio writes files that Pi later runs as code. Any page in the browser can send requests to localhost. Over a private network, a token link breaks easily, because each restart makes a new token. Behind a gateway that rewrites `Host`, the browser's `Origin` does not match anything the server can derive.

All-projects mode can open any project the server discovers. A browser must not be able to choose the folder.

## Decision

**By default the server binds 127.0.0.1 and checks a fresh random token on every API call.** The token travels in the `X-Studio-Token` header and is compared in constant time.

**`--no-token` turns the token off, for private networks only.** In that mode a `POST`, `PUT`, `PATCH` or `DELETE` gets 403 for cross-site or same-site fetch metadata or a disallowed `Origin`, and 415 for a body that is not `application/json`. This runs before any registry or project access. Allowed origins are `http://127.0.0.1:<port>`, `http://localhost:<port>` and the exact value of `--public-origin`. A request with no `Origin` and no cross-site metadata, such as the CLI, is allowed. `X-Forwarded-*` and `Forwarded` are never read, and no CORS headers are sent.

**`--public-origin` adds one exact gateway origin.** It requires `--no-token`. It is an allowlist entry, not authentication.

**In all-projects mode the client sends a project id, and the server maps it only to a root it discovered.** The id is a slug of the folder name, a hyphen and the first 8 hex characters of `sha256(realRoot)`. Scoped calls go to `/api/p/<id>/<rest>`. A malformed id gets 400 and an unknown id gets 404.

## Alternatives considered

| Option | Pros | Cons | Why not |
| --- | --- | --- | --- |
| Always require a token | One mode | Links break over a private network on every restart | Private-network use needs a tokenless mode |
| Trust `Sec-Fetch-Site: same-origin` alone | No flag | Depends on the header being sent | An exact configured origin is explicit |
| Localhost-only browser writes in tokenless mode | Simplest | Gateway saves stop working | Breaks the gateway case |
| Clients send project paths | No discovery step | The browser chooses which folder the server opens | Path control must stay on the server |

## Consequences

- **Positive**: a default start is reachable only from the same machine and only with the printed URL. A foreign page cannot write in tokenless mode. No request can point the server at a path.
- **Negative**: with `--no-token`, anyone on the network can still write, so it stays private-network only. A gateway save without `--public-origin` gets 403. A project appears only after discovery finds it.
- **Requires**: `--no-token` cannot be combined with `--dev-token`. `test/csrf.test.js` covers the tokenless rules. Single-project routes stay identical when served under `/api/p/<id>/`.

## Related

[ADR-0003](./ADR-0003-pi-plain-files-and-explicit-save.md) defines the files the API writes. [ADR-0008](./ADR-0008-pi-studio-command.md) starts instances with the default token.
