---
description: Start here to understand topology studio's language, architecture, design intent, testing and accepted decisions.
---

# Topology studio knowledge base

Topology studio is a local editor and run viewer for Pi workflows. It edits the state machine inside each workflow file and replays past runs against it. Pi runs the workflows. The studio never does.

Start with the [domain language](./CONTEXT.md) when a term such as *machine*, *gate*, *journal* or *replay* is unclear. It also lists the names the UI uses for each one.

Use the [architecture](./architecture.md) to find where work belongs. `shared/` is the pure core: the compiler, the runner and replay. `server/` does file IO and serves the API. `web/src` is the React app, and `pi/` adds `/studio` to Pi. When you change the UI, read the [design intent](./design-intent.md) first. Before you finish any change, follow the [testing guide](./testing.md).

The [architectural decision records](./docs/adr/INDEX.md) explain why the studio works this way. Read the relevant one before you propose a different file format, storage model, security rule or module boundary. Write a new ADR for every new decision.

## Suggested routes

If you need to change the workflow format, the runner or gates, start with the [machine and runner decision](./docs/adr/ADR-0001-machine-literal-and-embedded-runner.md), then the [core files table](./architecture.md#shared-the-functional-core). Run `npm run check:copies` after any runner change.

If you need to change runs, replay or playback, read the [run viewer decision](./docs/adr/ADR-0002-run-viewer-first.md) and the [run replay flow](./architecture.md#run-replay).

If you need to change saving or file access, read the [storage decision](./docs/adr/ADR-0003-pi-plain-files-and-explicit-save.md) alongside the [save flow](./architecture.md#save-with-stale-refusal).

If you need to change the HTTP API, flags or all-projects mode, read the [security decision](./docs/adr/ADR-0004-local-server-security.md) first.

If you need to change a screen, read the [design intent](./design-intent.md) and the [UI names](./CONTEXT.md#ui-names), then check it at 1440 px and 390 px as the [testing guide](./testing.md#check-the-ui) describes.

If you need to move code between folders or add a dependency, read the [module boundary decision](./docs/adr/ADR-0005-pure-core-io-at-the-edges.md) and the [packaging decision](./docs/adr/ADR-0006-typescript-and-dist-packaging.md).
