# Runs API

`GET /api/runs?workflow=<id>` returns `{ runs: Run[] }`, newest `updatedAt` first. The optional filter selects a resolved workflow id.
`GET /api/runs/:id` returns `RunDetail`. A run id is the journal filename without `.workflow.jsonl`.
Both endpoints require the normal `X-Studio-Token` header. They read the union of the project's `.pi/workflows/*.workflow.jsonl` files and Pi session journals at `<tmp>/pi-subagents-<uid>/<encoded-project>/*/tasks/*.workflow.jsonl`. They never write or execute workflow scripts.

The temporary root comes from `os.tmpdir()` when the project opens, not from request input. By default, the encoded path is the absolute, canonical project path. The server flag `--runs-from <dir>` uses that directory's absolute, canonical path instead, resolved from the current directory. It changes only the session root; project journals still load from the project's `.pi/workflows`. Session reads remain limited to `.workflow.jsonl` journals and sibling `.workflow.js` files under the selected session root. Encoding replaces every `/` or `\` with `-`, removes a leading Windows drive prefix matching `^[A-Za-z]:-`, then removes leading dashes. Missing session directories produce an empty session list. Project journals win when run ids overlap. Session ids and run ids must pass the safe-name check, and filesystem containment checks reject symlink escapes.

```text
Run = { id, source: "project"|"session", session?: string, workflow: string|null, candidates?: string[],
        path, startedAt: string|null, updatedAt: string,
        calls: number, status: "complete"|"partial", outcome?: "success"|"failed",
        signal?: "success"|"failed", at?: string, reason?: string, fits?: boolean, mismatch?: string,
        title?: string, current?: { state: string, visit: number } }
RunDetail = Run & { steps: Step[], visits: Record<string, number>, path: string[] }
Step = { n: number, state: string, branch?: string, kind: string, role: string|null, prompt: string, template: string,
         ok: boolean, result: object|null, text?: string, event?: string, to?: string,
         at?: string|null, durationMs?: number|null, gate?: { ok: boolean, output: string } }
```

`title` is the matched machine's `name`. It is absent when no machine matched or the name is empty.

`current` is present only for a matched partial run. `state` is the last state of the replayed path, and `visit` is that state's visit count, or 1 when it has none.

`title` and `current` come after every other key in both the list and the detail, so the detail ends with `steps, visits, title, current`. The detail's `path` keeps the list's position.

Session runs include `session`, the session directory name. In the list, `path` is the project-relative journal filename, which can start with `../` for a session journal outside the project. In detail, `path` is the ordered state path, including a reached final state. This follows the contract's detail override of the list field.
`n` starts at 1 and includes synthetic steps. `calls` counts journal entries, not synthetic steps. `visits` counts non-final state entries, including a waiting state or a visit that exceeds its limit.

`template` is the unfilled prompt source from the machine state, or from the matching branch for a fanout. `prompt` remains the filled prompt passed to the agent. Replay fills result, visit, and history references but preserves unknown `{{inputs.*}}` placeholders.

Each settled fanout branch has a step with `branch` set. A final synthetic step has `kind: "fanout"`, `role: null`, `prompt: ""`, `template: ""`, and the collected branch results. Its `ok` indicates whether the fanout resolved. Only the synthetic step carries the fanout's `event` and `to`. An unfinished fanout has only its settled branch steps.

`startedAt` uses the first recorded entry timestamp, falling back to filesystem birthtime. `updatedAt` uses filesystem mtime. Optional timestamps, durations, and gate results appear only when recorded. A run that stops at journal exhaustion is `partial` and has no outcome. A terminal state or fail-closed runner stop is `complete`, with `signal` equal to `outcome` and `at` naming the state where it ended. An agent call recorded with `ok: false` becomes a failed step, not a workflow mismatch. Without a failure transition, it ends the run with `signal: "failed"` and reason `<state>: agent failed`, preserving earlier steps.

## Journals and matching

Regenerate the council journal fixtures with `node scripts/generate-run-fixtures.js`.

Pi stores structured answers as JSON text in `text`, inside a JSONL entry. Replay parses that text only for schema calls. Invalid JSON or an invalid output shape becomes a failed step and a null host answer. Unknown inputs remain literal `{{inputs.x}}` placeholders, including inputs with defaults.

The reader sorts calls by `index`, tolerates a torn final line, and accepts optional `label`, `agentType`, `at`, and a `{ "kind": "run", "script": "<file>" }` header. Replay uses only the fixed runner and treats journal text as data.

For session runs, `workflow` uses a recorded `workflow` id from the journal first. Otherwise the reader extracts `meta.name` or the machine's `id` from the sibling `<runId>.workflow.js`. It parses literals without executing the script and caches the result by script mtime and size. Without either a recorded id or a sibling id, `workflow` is null. Replay uses the sibling machine when a sibling script exists. The project machine with the recorded id is used only when no sibling script exists. A known id without a replayable machine still appears with empty steps and `partial` status.

When a sibling script exists, `fits` says whether replay matched. If no model fits, the run remains visible with `fits: false` and a `mismatch` string describing the first disagreement, such as a label, agentType, unknown event, or output schema. Its steps, visits, and state path are empty, with `partial` status and no outcome. A sibling with no machine literal reports `script has no machine` and is never replayed against a same-named project workflow. A sibling whose machine cannot be replayed reports `Workflow machine cannot be replayed`. The page shows `Journal doesn't match this workflow: <reason>` instead of empty replay controls. Run lists show such a run as Mismatch once it has gone 3 minutes without an update. While it is fresher, it shows as Running.

Project journals keep the existing matching behavior. A journal matches a machine when all recorded calls fit its output schemas and the runner reaches no unknown event. Optional labels and agent types must also agree when recorded. One match resolves the workflow. With several matches, a header naming one of them resolves the tie. Otherwise `workflow` is null and `candidates` lists the matches. Unresolved details have empty steps, visits, and state path, and `partial` status because no state path is established.

Matching cannot distinguish machines with identical call shapes or short shared prefixes. Raw fanout answers carry no schema. A failed structured call can leave no identifying answer, and workflow edits can invalidate an older run. Cache entries use journal path and mtime, and invalidate when machine source changes.

Missing runs return 404. Invalid run ids return 400. Project containment violations return 422. `studio runs [--workflow <id>] [--json]` and `studio run <id> [--json]` use the same readers and JSON shapes.

## Project

`GET /api/project` returns `{ dir, workflows, roles, name, branch }`. `name` is the project folder name. `branch` is the checked-out branch read from `<project>/.git/HEAD` (following a worktree `gitdir:` pointer), or `null` when `HEAD` is detached, missing or unreadable.
