# Pi workflow JavaScript API

Export exactly one pure literal object:

```js
export const meta = {
  name: 'build',
  description: 'What this workflow does',
  whenToUse: 'When to use it',
  phases: [{ title: 'Build' }, { title: 'Review' }],
}
```

The rest is an async function body. Top-level await and return are allowed.
Use plain JavaScript, not TypeScript. No import or extra export.
Meta is literal data, never a variable, call, spread or computed property.

Globals:

- `args`: workflow arguments.
- `agent(prompt, options)`: runs an agent and returns text, a schema-validated object, or null on failure.
- Agent options: `label`, `phase`, `agentType`, `model`, `effort`, `isolation`, `gate`, `schema`. Unknown keys are rejected.
- `parallel(thunks)`: runs functions concurrently, waits for all, returns results in thunk order. A failed thunk becomes null.
- `pipeline(items, ...stages)`: stages receive `(prev, item, index)`. Returns an array, one result per item.
- `phase(title)`: sets the current phase for sequential work.
- `log(message)`: records a workflow message.

Inside parallel and pipeline, use the agent option `phase`, not a shared phase call.
The return value must be JSON-safe.
No filesystem access. No Date.now(), Math.random(), argumentless new Date(), eval or Function.

## Compiled machines

Topology studio writes `meta`, a top-level `const machine = {...}` pure literal, and the fixed runner from `shared/runner.ts`.
Acorn reads the literal back without executing the script. Hand-written scripts without that literal are not editable.

The runner applies input defaults, fills `{{inputs.x}}`, `{{results.state.field}}`, `{{visit}}`, and `{{run.history}}` in prompts and gates.
In a gate, each value is data: the runner passes it to the shell as one single-quoted word, so `test -f {{inputs.dir}}/plan.md` names one path even when it has spaces.
A gate that has a placeholder may not contain `'`, `"`, a backtick, `\`, `$`, `#`, `<<`, `[`, `]`, `(` or `)`. Validation rejects it, and the runner fails the run before any agent starts. Bash evaluates subscripts and arithmetic inside quotes, so brackets and parentheses are banned too: write `test -f {{inputs.x}}`, not `[ -f {{inputs.x}} ]`. Put such shell code in a script and pass the placeholder as a bare argument.
Each task or decision reports an `event` from its schema. The runner follows `on[event].to`.
When a task or decision has no output fields, its schema also requires a `text` report for `{{results.<state>.text}}`.
A fanout runs all branches concurrently, stores their text by branch id, and fires its single event after they settle.
Results retain each state's latest output. History records each state and event.

`maxVisits` caps a state's executions, with a default of three. A cap or failed task returns `outcome: 'failure'` with a `reason`.
A final state returns its `outcome`. The full result is `{ outcome, reason, at, history, results }`.
