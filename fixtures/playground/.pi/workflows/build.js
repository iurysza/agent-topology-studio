export const meta = {
  name: "build",
  description: "Coder builds an approved plan, two reviewers and the oracle agree fixes, a fresh coder applies them, QA proves it; reruns on QA failure",
  whenToUse: "After Iury approves a plan produced by the plan workflow.",
  phases: [
    {
      title: "Build"
    },
    {
      title: "Review"
    },
    {
      title: "Agree"
    },
    {
      title: "Fix"
    },
    {
      title: "QA"
    },
    {
      title: "Report"
    }
  ]
}

// machine: a state machine the runner below follows. Edit with topology studio or by hand; the
// studio reads this literal back. Keep it a pure literal.
const machine = {
  id: "build",
  name: "Build an approved plan",
  description: "Coder builds an approved plan, two reviewers and the oracle agree fixes, a fresh coder applies them, QA proves it; reruns on QA failure",
  whenToUse: "After Iury approves a plan produced by the plan workflow.",
  inputs: {
    slug: {
      type: "string",
      required: true,
      description: "Same directory name as the plan run under ai-artifacts/workflows"
    },
    dir: {
      type: "string",
      default: ".",
      description: "Project directory"
    },
    checks: {
      type: "string",
      default: "the project check and test scripts in package.json",
      description: "Checks to run before finishing"
    }
  },
  initial: "build",
  states: {
    build: {
      kind: "task",
      title: "Build",
      role: "coder",
      prompt: "Project directory: {{inputs.dir}}\nRead the approved plan at the plan files in ai-artifacts/workflows/{{inputs.slug}}/ and implement it.\n\nThis is attempt {{visit}}. On a retry the previous attempt's changes are already in the working tree. If QA previously failed, fix the causes in this report:\n{{results.qa.report}}\n\nRun {{inputs.checks}} before you finish. List the files you changed.",
      output: {
        summary: {
          type: "string",
          required: true,
          description: "Files changed and implementation summary"
        }
      },
      on: {
        built: {
          to: "review",
          description: "The change is in the working tree"
        }
      },
      maxVisits: 3
    },
    review: {
      kind: "fanout",
      title: "Review",
      branches: [
        {
          id: "a",
          role: "reviewer",
          prompt: "Project directory: {{inputs.dir}}\nPlan: the plan files in ai-artifacts/workflows/{{inputs.slug}}/\nCoder summary:\n{{results.build.summary}}\n\nReview the change for CORRECTNESS: bugs, unhandled failures, invalid states, missing tests. Use git diff."
        },
        {
          id: "b",
          role: "reviewer",
          prompt: "Project directory: {{inputs.dir}}\nPlan: the plan files in ai-artifacts/workflows/{{inputs.slug}}/\nCoder summary:\n{{results.build.summary}}\n\nReview the change for DESIGN and FIT: does it match the plan and the codebase conventions, are names clear, is it the simplest change? Use git diff."
        }
      ],
      on: {
        done: {
          to: "agree"
        }
      },
      maxVisits: 3
    },
    agree: {
      kind: "task",
      title: "Agree",
      role: "oracle",
      prompt: "Project directory: {{inputs.dir}}\nApproved plan: the plan files in ai-artifacts/workflows/{{inputs.slug}}/\n\nTwo reviewers looked at the same change.\n\nReviewer A:\n{{results.review.a.text}}\n\nReviewer B:\n{{results.review.b.text}}\n\nMerge their findings. Keep what is real and in scope of the plan; drop the rest with a reason. Resolve conflicts against the plan.",
      output: {
        fixes: {
          type: "string",
          required: true,
          description: "Numbered list of agreed fixes with file:line and the change"
        },
        dropped: {
          type: "string",
          required: true,
          description: "Findings rejected and why"
        }
      },
      on: {
        agreed: {
          to: "fix"
        }
      },
      maxVisits: 3
    },
    fix: {
      kind: "task",
      title: "Fix",
      role: "coder",
      prompt: "Project directory: {{inputs.dir}}\nApproved plan: the plan files in ai-artifacts/workflows/{{inputs.slug}}/\nThe change is already in the working tree. Apply ONLY these agreed fixes:\n{{results.agree.fixes}}\n\nRun {{inputs.checks}} before you finish.",
      output: {
        summary: {
          type: "string",
          required: true,
          description: "Agreed fixes applied and checks run"
        }
      },
      on: {
        fixed: {
          to: "qa"
        }
      },
      maxVisits: 3
    },
    qa: {
      kind: "decision",
      title: "QA",
      role: "qa",
      prompt: "Project directory: {{inputs.dir}}\nApproved plan: the plan files in ai-artifacts/workflows/{{inputs.slug}}/\nRun {{inputs.checks}}, then test the changed behaviour by hand. Decide pass or fail against the plan. On attempt {{visit}}, choose give_up if it still fails after three attempts.\n\nRun history:\n{{run.history}}",
      output: {
        report: {
          type: "string",
          required: true,
          description: "Evidence for every check: command and output, or browser steps and result"
        }
      },
      on: {
        pass: {
          to: "report",
          description: "QA proved the approved plan works"
        },
        fail: {
          to: "build",
          description: "Back to the coder with QA evidence"
        },
        give_up: {
          to: "gave_up",
          description: "QA still fails after the allowed attempts"
        }
      },
      maxVisits: 3
    },
    report: {
      kind: "task",
      title: "Report",
      role: "scribe",
      prompt: "QA passed. First update the project docs in {{inputs.dir}} that this change affects. Then write ai-artifacts/workflows/{{inputs.slug}}/run-report.html: a report of this build run for Iury. Show the outcome at the top (PASSED), then the plan, attempts, review findings and which were fixed, QA evidence, and anything left open.\n\nPlan file: the plan files in ai-artifacts/workflows/{{inputs.slug}}/\n\nRun log:\n{{run.history}}\n\nLatest coder summary:\n{{results.build.summary}}\nReviewer A:\n{{results.review.a.text}}\nReviewer B:\n{{results.review.b.text}}\nAgreed fixes:\n{{results.agree.fixes}}\nDropped:\n{{results.agree.dropped}}\nFresh coder:\n{{results.fix.summary}}\nQA:\n{{results.qa.report}}",
      on: {
        done: {
          to: "shipped"
        }
      },
      maxVisits: 1
    },
    shipped: {
      kind: "final",
      title: "Shipped",
      outcome: "success"
    },
    gave_up: {
      kind: "final",
      title: "Gave up",
      outcome: "failure"
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
