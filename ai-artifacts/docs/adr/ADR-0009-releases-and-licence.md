---
description: Records why the project is MIT licensed with its own styles and components, and why release automation exists but stays off.
---

# ADR-0009: MIT licence, original styles and releases off by default

This decision covers what may be published and how. The release steps live in [reference/releasing.md](../../../reference/releasing.md).

> **Quick Reference** | Status: Accepted | Date: 2026-11-05
> **Decision**: The project is MIT licensed. Its stylesheet, theme initializer and overlapping UI components are its own rewrites. Releases use release-please and npm trusted publishing, and they stay off until explicitly turned on. The package stays `private: true`.
> **Context**: The UI first copied styles and components from an upstream app under FSL-1.1-MIT, which blocked a permissive licence.
> **Alternatives**: Keep the copied styles; publish with a long-lived npm token
> **Impact**: `LICENSE`, `package.json`, `web/src/styles.css`, `web/index.html`, `web/src/graph.tsx`, `web/src/editor.tsx`, `web/src/parts.tsx`, `.github/workflows/`, `scripts/check-release.js`

---

## Context

The studio's look started as a copy of a reference app's design system. The stylesheet, the theme initializer and three components (`graph.tsx`, `editor.tsx` and `parts.tsx`) overlapped with that upstream code, which is FSL-1.1-MIT. The project could not be MIT while that code remained.

Publishing to npm also needs a safe path. A long-lived npm token in CI is a standing risk.

## Decision

**The stylesheet and theme initializer are rewritten from the DOM, class names and inline custom properties, with tokens the studio owns.** The three overlapping components are rewritten from a behaviour contract without the old source. Parity tests in `web/src/component-parity.test.ts` pass on both old and new code.

**The project is MIT licensed.** `check:pack` requires `LICENSE` in the package.

**release-please opens release pull requests on `main`. A published `v*` release runs CI on the tag, then `npm publish` signs in with OIDC.** Both workflows run only when `RELEASE_AUTOMATION_ENABLED` is `true` and the repository matches the configured one. `scripts/check-release.js` blocks a publish unless the tag matches the version and the package is public, licensed and points at that repository. Provenance is on only for a public repository.

**The package stays `private: true`, so publishing stays off.** Each activation step in `reference/releasing.md` needs its own approval.

## Alternatives considered

| Option | Pros | Cons | Why not |
| --- | --- | --- | --- |
| Keep the copied styles | Exact reference look | Blocks a permissive licence | MIT needs original code |
| An npm token secret in CI | Simple setup | Long-lived credential | OIDC trusted publishing needs no stored token |
| Publish on every merge | Fast releases | No review before a version ships | Release pull requests give a review step |

## Consequences

- **Positive**: the code can be shared under a standard permissive licence. Versions and the changelog come from commits, with no stored npm token.
- **Negative**: the look changed with the rewrite. Earlier copied versions remain in this repository's git history. A private repository publishes without provenance.
- **Requires**: release-please needs a `RELEASE_PLEASE_TOKEN` personal access token, because a release made with `GITHUB_TOKEN` does not start another workflow. Dropping `private: true` needs explicit approval.

## Related

[ADR-0006](./ADR-0006-typescript-and-dist-packaging.md) defines the package name and contents the release gate checks.
