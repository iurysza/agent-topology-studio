---
description: Records why a workflow file is a machine literal plus a fixed runner, and why gate placeholders are shell-quoted data.
---

# ADR-0001: A workflow is a machine literal run by an embedded runner

This decision defines the workflow file format that the [architecture](../../architecture.md) reads and writes. Use the [domain language](../../CONTEXT.md) for machine, runner, gate and placeholder.

> **Quick Reference** | Status: Accepted | Date: 2026-10-23
> **Decision**: A workflow file holds a `const machine` literal plus a fixed runner. The studio compiles it with no model in the loop. A task may carry a gate, and the runner passes every gate placeholder as single-quoted shell data.
> **Context**: An earlier design had an agent translate a drawing into workflow JavaScript, and the result could not be read back reliably.
> **Alternatives**: An agent writes and reads the JavaScript; gates filled with raw text
> **Impact**: `shared/machine.ts`, `shared/runner.ts`, `shared/gate.ts`, every `.pi/workflows/<id>.js`, the editor, the CLI

---

## Context

An earlier design asked an agent to write the workflow JavaScript from a diagram and read it back. That went the wrong way round. The diagram could not be recovered exactly from arbitrary code, and every edit cost a model call.

Agents also reported work as done that they had not done. A plan run once ended `drafted` without writing `plan.md`. The runner needed a way to check a result, not trust the claim.

That check is a shell command. The runner first filled placeholders into it as raw text, so a value such as `x; touch PWNED` or `$(...)` from a workflow argument or an agent's reply ran as code.

## Decision

**A workflow is a `const machine` literal followed by a runner that is the same in every file.** `compile` writes the machine to `.pi/workflows/<id>.js` with no model. `extract` reads the literal back. The runner string lives in `shared/runner.ts`.

**A task state or a fanout branch may carry a `gate`.** The gate is a shell command whose success proves the state's work exists. If it fails and the state has a `failed` transition, the run takes it. If not, the run stops with a reason.

**A gate template is trusted shell code. Every placeholder value is untrusted data.** The runner passes each value to `sh` as one single-quoted word. Text next to a placeholder joins it into one word, so `test -f {{inputs.dir}}/plan.md` names one path even with spaces in it. An empty value becomes `''`. Prompts keep raw filling.

Single quotes keep a value inert only in plain, unquoted shell words. Bash evaluates `$(...)` inside a single-quoted word in arithmetic contexts such as array subscripts, `[[` and `((`. So a gate with any placeholder may not contain `'`, `"`, a backtick, `\`, `$`, `#`, `<<`, `[`, `]`, `(` or `)`. `validateMachine` reports such a gate, so the studio and the CLI refuse to save it. The runner checks every gate again before the first agent runs. A gate with no placeholder may use any shell syntax.

## Alternatives considered

| Option | Pros | Cons | Why not |
| --- | --- | --- | --- |
| An agent writes and reads the JavaScript | Any workflow shape | Round-trip is lossy, slow and costs a model call per edit | The result did not match what was drawn |
| Trust the agent's reported event | No extra config | Agents claim work they did not do | Runs failed on false claims |
| Raw placeholder filling in gates | Any shell syntax works | Arguments and agent replies run as code | Command injection |
| A shell parser that quotes context-aware | Fewer banned characters | Large, hard to prove correct | A whole-template rule is small and testable |

## Consequences

- **Positive**: compile and read-back round-trip exactly, and the studio never calls a model. A state's result is checked by a command. Values with spaces, `;`, newlines and `$()` reach a gate as data.
- **Negative**: the UI can build only what the machine format can say. A gate such as `[ -f {{inputs.dir}} ]` is refused. Move that logic into a script and pass the placeholder as a bare argument. A trusted command that itself runs its argument as code, such as `eval` or `sh -c`, still runs the value.
- **Requires**: every runner change updates every workflow copy. `npm run check:copies` and `test/runner-boundary.test.js` fail on a stale copy. `shared/gate.ts` is the one source for runner quoting and validation.

## Related

[ADR-0002](./ADR-0002-run-viewer-first.md) uses the same runner for offline replay. [ADR-0003](./ADR-0003-pi-plain-files-and-explicit-save.md) covers how the file is saved.
