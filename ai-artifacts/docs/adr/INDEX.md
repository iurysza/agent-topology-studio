---
description: Routes topology studio changes to the accepted decisions behind its file format, product focus, boundaries, security and packaging.
---

# Architectural decision records

Read this index after the [knowledge-base overview](../../_index.md) points you at a decision-shaped question. The [architecture](../../architecture.md) shows where each decision takes effect. Open an ADR when its decision or impact matches your change. To change a decision, write a new ADR that supersedes it. Do not rewrite the old one.

## Active decisions

| ADR | Decision | Impact | Date |
| --- | --- | --- | --- |
| [0001](./ADR-0001-machine-literal-and-embedded-runner.md) | A workflow is a machine literal run by an embedded runner. Gate placeholders are shell-quoted data | Workflow format, runner, gates, CLI | 2026-10-23 |
| [0002](./ADR-0002-run-viewer-first.md) | The studio is a run viewer first, not a visual editor | Navigation, replay, roadmap | 2026-10-23 |
| [0003](./ADR-0003-pi-plain-files-and-explicit-save.md) | Pi's plain files are the only storage. Save is explicit and stale saves are refused | Server file access, save API, editor | 2026-10-23 |
| [0004](./ADR-0004-local-server-security.md) | Token by default, origin checks without it, project ids instead of paths | HTTP server, CLI flags, all-projects mode | 2026-10-24 |
| [0005](./ADR-0005-pure-core-io-at-the-edges.md) | Pure `shared/` core, IO at the edges, Effect only in `server/` | Module boundaries, lint, error handling | 2026-10-24 |
| [0006](./ADR-0006-typescript-and-dist-packaging.md) | Strict TypeScript source, `dist/` packaging, one tool root, `agent-topology-studio` name | Build, package, process spawning | 2026-10-25 |
| [0007](./ADR-0007-tests-prove-behaviour.md) | Tests prove behaviour, and lint warnings only go down | Tests, lint, review | 2026-10-24 |
| [0008](./ADR-0008-pi-studio-command.md) | `/studio` opens a detached instance for the current project | Pi extension, instances | 2026-10-04 |
| [0009](./ADR-0009-releases-and-licence.md) | MIT licence, original styles, releases off by default | Licence, styles, release workflows | 2026-11-05 |

## Superseded decisions

None.

## By category

### Product and format

- [ADR-0001](./ADR-0001-machine-literal-and-embedded-runner.md): A workflow is a machine literal run by an embedded runner.
- [ADR-0002](./ADR-0002-run-viewer-first.md): A run viewer first, not a visual editor.
- [ADR-0003](./ADR-0003-pi-plain-files-and-explicit-save.md): Pi's plain files are the only storage, and saves are explicit.

### Security

- [ADR-0004](./ADR-0004-local-server-security.md): Local server security.

### Code structure and quality

- [ADR-0005](./ADR-0005-pure-core-io-at-the-edges.md): Pure core, IO at the edges, Effect only in `server/`.
- [ADR-0006](./ADR-0006-typescript-and-dist-packaging.md): TypeScript source, `dist/` packaging and one tool root.
- [ADR-0007](./ADR-0007-tests-prove-behaviour.md): Tests prove behaviour, and lint warnings only go down.

### Integration and release

- [ADR-0008](./ADR-0008-pi-studio-command.md): Pi integration through `/studio`.
- [ADR-0009](./ADR-0009-releases-and-licence.md): MIT licence, original styles and releases off by default.
