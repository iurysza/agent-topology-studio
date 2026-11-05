---
description: Records why the studio is first a viewer of workflows and runs, with replay and playback, rather than a visual editor.
---

# ADR-0002: A run viewer first, not a visual editor

This decision sets the product's priorities, which the [design intent](../../design-intent.md) turns into UI rules. Replay and playback are defined in the [domain language](../../CONTEXT.md).

> **Quick Reference** | Status: Accepted | Date: 2026-10-23
> **Decision**: The studio is first a viewer of workflows and runs. Runs are a top-level tab with offline replay and playback, and they get new investment before the editor.
> **Context**: Agents edit text better than people edit diagrams, so a visual editor alone is a weak reason to exist.
> **Alternatives**: Build the studio as a visual editor first
> **Impact**: Top-level navigation, `shared/replay.ts`, `server/runs.ts`, the Runs pages, roadmap order

---

## Context

The studio began as a tool to draw workflows. The strongest criticism of that idea is simple: an agent can already edit a workflow file well, and many people build workflows from plain text. What nobody had was a clear view of what a run actually did.

Pi writes a `<runId>.workflow.jsonl` journal for each run. That journal holds enough to rebuild the path a run took.

## Decision

**The studio is a viewer of workflows and runs first. Runs get the next investment.**

Runs is a top-level tab beside Workflows and Roles, filtered by workflow. The studio reads each journal and replays it through its own copy of the runner. Playback has back and forward controls and steps one state at a time. It does not stream tokens.

Editing is not frozen. It stays, but it comes second, and agents keep a text path through the workflow file and the `studio` CLI.

## Alternatives considered

| Option | Pros | Cons | Why not |
| --- | --- | --- | --- |
| Visual editor as the main product | Matches the "draw a workflow" pitch | Agents edit text better than people edit diagrams | Seeing runs is where the studio adds value |

## Consequences

- **Positive**: you can see which states a run visited, in order, and where it failed.
- **Negative**: editor polish waits behind runs. Replay depends on the journal fields Pi writes, so an upstream change can break it.
- **Requires**: the runner in the studio and in workflow files must match ([ADR-0001](./ADR-0001-machine-literal-and-embedded-runner.md)). Agents must be able to edit workflows as text.

## Related

[ADR-0001](./ADR-0001-machine-literal-and-embedded-runner.md) defines the runner replay uses. [ADR-0003](./ADR-0003-pi-plain-files-and-explicit-save.md) says where the journals live.
