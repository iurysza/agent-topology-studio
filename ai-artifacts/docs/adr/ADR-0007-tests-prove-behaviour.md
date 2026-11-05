---
description: Records why every test must fail when its behaviour breaks, and why the anti-slop lint plugin stays on with a warning count that only goes down.
---

# ADR-0007: Tests prove behaviour, and lint warnings only go down

This decision governs every change. The [testing guide](../../testing.md) turns it into commands.

> **Quick Reference** | Status: Accepted | Date: 2026-10-24
> **Decision**: A test must fail when the behaviour it names breaks. Feature changes are checked in the real UI. The anti-slop oxlint plugin stays on, and its noisy rules run at `warn` with a count that must not grow.
> **Context**: A green suite full of existence checks proved nothing, and generated code drifts into patterns that are hard to read.
> **Alternatives**: Count coverage only; reformat everything at once; turn the noisy rules off
> **Impact**: `test/`, `web/src/*.test.ts`, `oxlint.config.ts`, `tools/oxlint/anti-slop/`, code review

---

## Context

Early tests checked that a function or an element existed, or that a mock returned what the test fed it. They passed whatever the code did.

The anti-slop oxlint plugin flags patterns common in generated code. Turning every rule to `error` at once would have failed the build on about 1,500 spacing findings, and an autofix would have reformatted 41 files.

## Decision

**A test earns its place only if it fails when the behaviour it names breaks.** Delete or rewrite a test that only proves something exists, asserts a constant equals its own literal, asserts a mock returned its input, or repeats a stronger test. A new test for a feature must fail on the base commit and pass on the change.

**Feature changes and refactors are checked by using the product.** Drive the real UI, take screenshots and read them. A refactor must not change behaviour, and golden pins in `test/pins/` hold it to that.

**The anti-slop plugin stays on.** Rules with zero findings run at `error`. `require-readable-spacing` and the other noisy rules run at `warn`. New code must not add warnings, and a rule goes back to `error` when its findings are fixed.

## Alternatives considered

| Option | Pros | Cons | Why not |
| --- | --- | --- | --- |
| A coverage target | Easy to measure | Rewards tests that touch code without checking it | Coverage is not behaviour |
| One `--fix` commit | Zero warnings at once | Reformats 41 files in one change | A style change that large hides real diffs |
| Turn noisy rules off | No noise | Loses the checks | The checks are useful |

## Consequences

- **Positive**: a green suite means the behaviour holds. The plugin flags new slop without a large reformat.
- **Negative**: checking a feature in the browser costs time per change. The warning count stays high until someone fixes the findings.
- **Requires**: reviewers reject tautological tests. `npm run lint` shows 0 errors and no new warnings.

## Related

[ADR-0005](./ADR-0005-pure-core-io-at-the-edges.md) uses lint and a fence test to hold the module boundaries.
