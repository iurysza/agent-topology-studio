---
description: Records why the studio stores nothing of its own, saves only on demand and refuses a save on a file that changed on disk.
---

# ADR-0003: Pi's plain files are the only storage, and saves are explicit

This decision fixes where data lives, which the [architecture](../../architecture.md#where-state-lives) lists, and how the editor writes it, shown in the [save flow](../../architecture.md#save-with-stale-refusal).

> **Quick Reference** | Status: Accepted | Date: 2026-10-23
> **Decision**: The studio keeps workflows, roles and run journals only in Pi's own plain files and shows each file's path. It writes only on Save and refuses a save whose base hash no longer matches the file.
> **Context**: Autosave once wrote half-typed text into a workflow file, and the same files are edited by agents, git and other editors.
> **Alternatives**: A studio database; autosave after 500 ms
> **Impact**: `server/project.ts`, `server/errors.ts`, `server/http-errors.ts`, the save API, the editor, the path button

---

## Context

A workflow, a role and a run journal are already plain files that Pi reads and writes. Agents, git and text editors change the same files. A second store would drift from them.

The editor used to autosave 500 ms after each change. During testing, autosave wrote stray text into a workflow file. With explicit save, a user could get stuck on a screen with unsaved changes and no way out.

## Decision

**The studio's data is Pi's own files, and the UI names the file it shows.**

- a workflow: `.pi/workflows/<id>.js`
- a role: `.pi/agents/<name>.md`
- a run journal: `<runId>.workflow.jsonl`, written by Pi

Pi runs workflows without the studio. Browser-local UI state, such as theme and last-seen timestamps, is allowed because it is disposable.

**Nothing is written to disk until the user presses Save.** A guard warns before leaving with unsaved changes, and Discard drops them. Each save carries the hash of the file it was based on. If the file changed on disk, the server raises `StaleError` and answers 409 with the current hash. The editor offers Reload.

## Alternatives considered

| Option | Pros | Cons | Why not |
| --- | --- | --- | --- |
| A studio database | Room for data with no home in Pi's files | Drifts from the files Pi runs | Pi's files are the truth |
| Autosave after 500 ms | No lost edits | Writes half-typed text into a runnable file | It corrupted a file in testing |
| Last write wins | Simpler server | Silently loses an agent's or another editor's change | The hash check is cheap |

## Consequences

- **Positive**: any editor, git or Pi can read and change the same files, and nothing is lost if the studio is deleted. A file changes only when the user means it to.
- **Negative**: the studio cannot add data that has no home in these files. A user loses unsaved edits by pressing Discard.
- **Requires**: the save API keeps sending the base hash, and `test/http-errors.test.js` pins the 409 body. The editor keeps the path button.

## Related

[ADR-0001](./ADR-0001-machine-literal-and-embedded-runner.md) defines the file being saved. [ADR-0004](./ADR-0004-local-server-security.md) guards the API that writes it.
