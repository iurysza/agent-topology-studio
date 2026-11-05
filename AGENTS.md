# Topology studio

Topology studio is a local editor and run viewer for Pi workflows. It edits the state machine inside each workflow file and replays past runs. Pi runs the workflows.

Read [`ai-artifacts/_index.md`](ai-artifacts/_index.md) first.

## Code rules

1. Functional core, imperative shell. `shared/` is pure: no Node built-ins and no Effect. IO lives only at the edges: server/, bin/, pi/, scripts/ or web/src/api.ts. `oxlint.config.ts` and `test/effect-fence.test.js` enforce this ([ADR-0005](ai-artifacts/docs/adr/ADR-0005-pure-core-io-at-the-edges.md)).
2. Effect only in `server/` ([ADR-0005](ai-artifacts/docs/adr/ADR-0005-pure-core-io-at-the-edges.md)).
3. Tests prove behaviour. A new test must fail without the change. No existence checks and no mock-returns-input tests ([ADR-0007](ai-artifacts/docs/adr/ADR-0007-tests-prove-behaviour.md)).
4. `npm run lint` shows 0 errors. Do not add warnings ([ADR-0007](ai-artifacts/docs/adr/ADR-0007-tests-prove-behaviour.md)).
5. Source in `shared/`, `server/`, `pi/` and `bin/` is strict TypeScript. `tsc` builds it to `dist/`, the published package. Tests run the `.ts` files under Node 22.18 type stripping ([ADR-0006](ai-artifacts/docs/adr/ADR-0006-typescript-and-dist-packaging.md)).
6. A refactor does not change product behaviour.

## Testing

Follow [`ai-artifacts/testing.md`](ai-artifacts/testing.md). Use ports 4960 to 4969 for hand testing. Run the leak check before you share a screenshot.

## Decisions

Write an ADR for every new decision, when you make it. Start from the [ADR index](ai-artifacts/docs/adr/INDEX.md) and copy the shape of an existing ADR.
