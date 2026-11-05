---
description: Records why source is strict TypeScript run by Node's type stripping, why the package ships dist/, how the tool root is found and what the package is called.
---

# ADR-0006: TypeScript source, `dist/` packaging and one tool root

This decision shapes the build and the published package described in the [architecture](../../architecture.md). Tool root and code root are defined in the [domain language](../../CONTEXT.md).

> **Quick Reference** | Status: Accepted | Date: 2026-10-25
> **Decision**: Source is strict TypeScript that runs under Node's type stripping. The package ships `tsc` output in `dist/`. `toolRoot` walks up to `package.json`, and a child process runs the same tree as its parent. The package and executable are `agent-topology-studio`.
> **Context**: The project should be easy to install, maintain and share. Node cannot strip types under `node_modules`, so an installed copy cannot run `.ts`.
> **Alternatives**: `.js` with JSDoc; a `tsx` runtime dependency; a self-reference through the package name
> **Impact**: `tsconfig.build.json`, `package.json` (`bin`, `exports`, `files`, `pi.extensions`), `server/tool-root.ts`, `scripts/check-pack.js`

---

## Context

The code started as JavaScript with JSDoc types and `.d.ts` sidecars. The sidecars drifted and the types were weak. Strict mode on all source at once gave hundreds of errors.

Several files computed the package root from `import.meta.url`. Once the package ships `dist/`, that gives the wrong directory from compiled code. Spawning a fixed `.js` path could also run stale `dist/` code from a source checkout.

The original package name, `topology-studio`, did not say what the tool is for.

## Decision

**All runtime code in `shared/`, `server/`, `pi/` and `bin/` is strict TypeScript.** Source runs as `.ts` under Node's type stripping, so contributors need Node 22.18 or newer. `tsconfig.build.json` is fully strict. Both tsconfigs turn on `erasableSyntaxOnly`, `verbatimModuleSyntax`, `allowImportingTsExtensions` and `rewriteRelativeImportExtensions`, so source imports end in `.ts` and `dist/` imports end in `.js`.

**`dist/` is the published surface and mirrors the source layout.** `npm run build:ts` runs `rm -rf dist && tsc -p tsconfig.build.json`. `npm test` and `prepack` run it first. `bin`, `exports` and `pi.extensions` point at `dist/`. The package ships `dist/`, `web/dist/`, `reference/` and `LICENSE`.

**`toolRoot` walks up from its module to the first `package.json`.** `resolveEntry(rel)` returns `<codeRoot>/<rel>.ts` when it exists, else `<codeRoot>/<rel>.js`, so a child runs the same tree as its parent. `server/tool-root.ts` imports only `node:` built-ins, because `bin/studio.ts` loads it before `npm install`.

**The package and its executable are `agent-topology-studio`.** Internal names keep `topology-studio`: `/studio`, the state and config folders, browser storage keys, the Effect service tag and the Pi menu group. Renaming them would orphan existing records, configs and saved tokens.

## Alternatives considered

| Option | Pros | Cons | Why not |
| --- | --- | --- | --- |
| `.js` with JSDoc and sidecars | No build step | Weak types; sidecars drift | TypeScript gives real types |
| `tsx` as a runtime | Works on older Node | One more tool between source and runtime | Node's stripping needs nothing extra |
| Strict on every folder at once | One switch | Hundreds of errors in one change | Per-file strict lands in small slices |
| Find the root through `<name>/package.json` | One resolve call | Breaks silently on a rename | Walking up does not depend on the name |

## Consequences

- **Positive**: one typed language across the runtime. `dist/` is a plain rewrite of the same code, and paths relative to the tool root stay the same. The public name says what the tool does, and existing state keeps working.
- **Negative**: source needs Node 22.18. `engines` stays `>=22.12`, because installed copies run `dist/`. A stray `package.json` inside `dist/` would move the root. Public and internal names differ.
- **Requires**: no `enum`, `namespace`, parameter properties or `import =` in source. No `any`, `!` or `@ts-ignore` in strict files. `check:pack` fails when `dist/` holds a `package.json`. `test/tool-root.test.js` covers renamed and `dist/` layouts.

## Related

[ADR-0005](./ADR-0005-pure-core-io-at-the-edges.md) covers reading `unknown` caught values. [ADR-0009](./ADR-0009-releases-and-licence.md) covers publishing the package.
