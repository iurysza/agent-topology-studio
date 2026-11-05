export const meta = {
  name: "plan",
  description: "Lead writes the Markdown plan, oracle challenges it until approved, scribe writes the HTML explainer",
  whenToUse: "Before building anything non-trivial. Stops for Iury to approve the plan.",
  phases: [
    {
      title: "Plan"
    },
    {
      title: "Challenge"
    },
    {
      title: "Revise plan"
    },
    {
      title: "Explain"
    }
  ]
}

// machine: a state machine the runner below follows. Edit with topology studio or by hand; the
// studio reads this literal back. Keep it a pure literal.
const machine = {
  id: "plan",
  name: "Plan and challenge a task",
  description: "Lead writes the Markdown plan, oracle challenges it until approved, scribe writes the HTML explainer",
  whenToUse: "Before building anything non-trivial. Stops for Iury to approve the plan.",
  inputs: {
    task: {
      type: "string",
      required: true,
      description: "The task to plan"
    },
    slug: {
      type: "string",
      required: true,
      description: "Directory name under ai-artifacts/workflows"
    },
    dir: {
      type: "string",
      default: ".",
      description: "Project directory"
    }
  },
  initial: "draft",
  states: {
    draft: {
      kind: "task",
      title: "Plan",
      role: "lead",
      prompt: "Project directory: {{inputs.dir}}\nWrite your Markdown plan files in: ai-artifacts/workflows/{{inputs.slug}}/\n\nTask:\n{{inputs.task}}",
      output: {
        summary: {
          type: "string",
          required: true,
          description: "Summary of the Markdown plan files"
        }
      },
      on: {
        drafted: {
          to: "challenge",
          description: "The plan files are ready for challenge"
        }
      },
      maxVisits: 1
    },
    challenge: {
      kind: "decision",
      title: "Challenge",
      role: "oracle",
      prompt: "Project directory: {{inputs.dir}}\nTask:\n{{inputs.task}}\n\nThe lead's plan is in ai-artifacts/workflows/{{inputs.slug}}/. Lead's initial summary:\n{{results.draft.summary}}\n\nLatest revision, if present:\n{{results.revise.summary}}\n\nRead the plan files and the relevant code. Look for drift from the task, hidden assumptions, missing tests and risky steps. Approve only if it is ready to build. This is challenge round {{visit}}.",
      output: {
        feedback: {
          type: "string",
          required: true,
          description: "What must change, or why it is approved"
        }
      },
      on: {
        approved: {
          to: "explain",
          description: "The plan is ready to build"
        },
        changes: {
          to: "revise",
          description: "The lead must address the oracle feedback"
        }
      },
      maxVisits: 3
    },
    revise: {
      kind: "task",
      title: "Revise plan",
      role: "lead",
      prompt: "Project directory: {{inputs.dir}}\nYour plan files are in ai-artifacts/workflows/{{inputs.slug}}/. Revise them in place using this oracle feedback:\n{{results.challenge.feedback}}",
      output: {
        summary: {
          type: "string",
          required: true,
          description: "Summary of the revised plan"
        }
      },
      on: {
        revised: {
          to: "challenge"
        }
      },
      maxVisits: 3
    },
    explain: {
      kind: "task",
      title: "Explain",
      role: "scribe",
      prompt: "Read the plan files in ai-artifacts/workflows/{{inputs.slug}}/ and the code they reference in {{inputs.dir}}. Write ai-artifacts/workflows/{{inputs.slug}}/plan.html: a visual explainer for Iury to review and approve before anything is built.\n\nOracle status, show it prominently at the top: Approved by the oracle. {{results.challenge.feedback}}\n\nTask:\n{{inputs.task}}",
      on: {
        done: {
          to: "approved"
        }
      },
      maxVisits: 1
    },
    approved: {
      kind: "final",
      title: "Approved",
      outcome: "success"
    }
  }
}

const inputs = {}
for (const [k, f] of Object.entries(machine.inputs ?? {})) {
  const v = args?.[k] === undefined ? f.default : args[k]
  const reason = v === undefined && f.required ? `${machine.id} needs args.${k}: ${f.description ?? f.type}` : v !== undefined && ['number', 'boolean', 'string', 'array'].includes(f.type) && (f.type === 'array' ? !Array.isArray(v) : typeof v !== f.type || (f.type === 'number' && !Number.isFinite(v))) ? `${machine.id} args.${k} must be ${f.type}` : null
  if (reason) return { outcome: 'failure', reason, at: machine.initial, history: [], results: Object.create(null) }
  inputs[k] = v
}
const results = Object.create(null), history = [], visits = Object.create(null)
const get = (path) => path.split('.').reduce((o, k) => (o == null || !Object.hasOwn(o, k) ? undefined : o[k]), { inputs, results, run: { history: history.join('\n') } })
const fill = (tpl, extra, word = (v) => v) => tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, p) => { const v = p === 'visit' ? extra.visit : get(p); return word(v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v)) }); const shellWord = (v) => "'" + v.replaceAll("'", "'\\''") + "'", gateProblem = (tpl) => { const p = tpl.match(/\{\{\s*([\w.]+)\s*\}\}/), c = p && tpl.replace(/\{\{\s*[\w.]+\s*\}\}/g, ' ').match(/['"\x60\\$#[\]()]|<</); return c ? 'uses {{' + p[1] + '}} with ' + c[0] + '. A gate with a placeholder cannot contain quotes, a backtick, \\, $, #, <<, [, ], ( or ), because the runner single-quotes each value and bash still evaluates subscripts and arithmetic. Use test instead of [ ], or put that shell code in a script and pass the placeholder as a bare argument.' : null }; for (const [where, gate] of Object.entries(machine.states).flatMap(([id, s]) => [[id, s.gate], ...(s.branches ?? []).map((b) => [`${id} branch ${b.id}`, b.gate])])) { const problem = typeof gate === 'string' && gateProblem(gate); if (problem) return { outcome: 'failure', reason: `${where} gate ${problem}`, at: machine.initial, history: [], results: Object.create(null) } }
const schemaFor = (s) => {
  const props = { event: { type: 'string', enum: Object.keys(s.on), description: Object.entries(s.on).map(([e, t]) => `${e}: ${t.description ?? '→ ' + t.to}`).join('; ') } }
  const required = ['event']
  for (const [k, f] of Object.entries(s.output ?? {})) { props[k] = { type: f.type, ...(f.description === undefined ? {} : { description: f.description }) }; if (f.required) required.push(k) }
  if (!Object.keys(s.output ?? {}).length) { props.text = { type: 'string', description: 'Your report for the next step' }; required.push('text') }
  return { type: 'object', properties: props, required }
}
let at = machine.initial, outcome = 'failure', reason = null
while (true) {
  const s = machine.states[at]
  if (s.kind === 'final') { outcome = s.outcome; break }
  visits[at] = (visits[at] ?? 0) + 1
  const max = s.maxVisits ?? 3
  if (visits[at] > max) { reason = `${at} ran ${max} times without reaching an end`; break }
  phase(s.title, { at, visits: { ...visits } })
  let event
  if (s.kind === 'fanout') {
    const out = await parallel(s.branches.map((b) => async () => { try { return await agent(fill(b.prompt, { visit: visits[at] }), { agentType: b.role, label: `${at}:${b.id}`, phase: s.title, ...(b.gate ? { gate: fill(b.gate, { visit: visits[at] }, shellWord) } : {}) }) } catch (e) { log(`${at}:${b.id} failed: ${e?.message ?? e}`); return null } }))
    results[at] = Object.fromEntries(s.branches.map((b, i) => [b.id, out[i] == null ? null : { text: out[i] }]))
    const failed = s.branches.find((b, i) => out[i] == null)
    if (failed && !Object.hasOwn(s.on, 'failed')) { reason = `${at}: branch ${failed.id} failed`; break }
    event = failed ? 'failed' : Object.keys(s.on).find(e => e !== 'failed')
  } else {
    let r; try { r = await agent(fill(s.prompt, { visit: visits[at] }), { agentType: s.role, label: visits[at] > 1 ? `${at}:${visits[at]}` : at, schema: schemaFor(s), ...(s.gate ? { gate: fill(s.gate, { visit: visits[at] }, shellWord) } : {}) }) } catch (e) { if (!s.gate || !Object.hasOwn(s.on, 'failed')) { reason = `${at} failed: ${e?.message ?? e}`; break } log(`${at} failed: ${e?.message ?? e}`); r = null }
    if (s.gate && r === null && Object.hasOwn(s.on, 'failed')) r = { event: 'failed' }
    event = r !== null && typeof r === 'object' && !Array.isArray(r) ? r.event : r
    if (r === null || typeof r !== 'object' || Array.isArray(r) || typeof event !== 'string' || !Object.hasOwn(s.on, event)) { reason = r === null ? `${at}: agent failed` : `${at}: unknown event ${event !== null && typeof event === 'object' ? JSON.stringify(event) : event}`; break }
    results[at] = r
  }
  history.push(`${at} → ${event}`)
  log(`${at} → ${event}`, { at, event, to: s.on[event].to, result: results[at] })
  at = s.on[event].to
}
return { outcome, reason, at, history, results, visits }
