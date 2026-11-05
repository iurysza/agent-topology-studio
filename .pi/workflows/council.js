export const meta = {
  name: "council",
  description: "Three distinct models vote on a high-stakes question; a judge tallies, one deliberation round if split",
  whenToUse: "Before merging or deciding anything risky. Nothing in the council changes code.",
  phases: [
    {
      title: "Frame"
    },
    {
      title: "Vote"
    },
    {
      title: "Tally"
    },
    {
      title: "Deliberate"
    }
  ]
}

// machine: a state machine the runner below follows. Edit with topology studio or by hand; the
// studio reads this literal back. Keep it a pure literal.
const machine = {
  id: "council",
  name: "Council",
  description: "Three distinct models vote on a high-stakes question; a judge tallies, one deliberation round if split",
  initial: "frame",
  states: {
    frame: {
      kind: "task",
      title: "Frame",
      role: "lead",
      prompt: "Project directory: {{inputs.dir}}\nQuestion: {{inputs.question}}\nContext: {{inputs.context}}\nYou are read-only. Do not change code or any files.\nWrite a brief stating what is being decided, 3–6 concrete checks, and what evidence would settle each check.\nReturn the brief in the required brief output field, then fire framed.",
      on: {
        framed: {
          to: "vote"
        }
      },
      maxVisits: 1,
      output: {
        brief: {
          type: "string",
          required: true
        }
      }
    },
    approved: {
      kind: "final",
      title: "Approved",
      outcome: "success"
    },
    vote: {
      kind: "fanout",
      title: "Vote",
      branches: [
        {
          id: "skeptic",
          role: "skeptic",
          prompt: "Project directory: {{inputs.dir}}\nBrief:\n{{results.frame.brief}}\nRound 1: vote independently. You are read-only. Check the brief's items against the real code and tests; run commands if it helps. Do not change anything.\nLens: correctness and safety. Only you may veto, and only for a concrete safety or data-loss issue you can point to.\nReply with a ballot exactly in this shape:\nverdict: approve|block|abstain\nconfidence: low|medium|high\nveto: yes|no (skeptic only, otherwise no)\nreasons:\n- file:line evidence\nconditions: what would change your vote"
        },
        {
          id: "auditor",
          role: "auditor",
          prompt: "Project directory: {{inputs.dir}}\nBrief:\n{{results.frame.brief}}\nRound 1: vote independently. You are read-only. Check the brief's items against the real code and tests; run commands if it helps. Do not change anything.\nLens: evidence. Do the tests prove the claims, what is untested, and does the diff match its description?\nReply with a ballot exactly in this shape:\nverdict: approve|block|abstain\nconfidence: low|medium|high\nveto: yes|no (skeptic only, otherwise no)\nreasons:\n- file:line evidence\nconditions: what would change your vote"
        },
        {
          id: "pragmatist",
          role: "pragmatist",
          prompt: "Project directory: {{inputs.dir}}\nBrief:\n{{results.frame.brief}}\nRound 1: vote independently. You are read-only. Check the brief's items against the real code and tests; run commands if it helps. Do not change anything.\nLens: scope, simplicity and cost of ownership. Is this the smallest change, and what would it break for users?\nReply with a ballot exactly in this shape:\nverdict: approve|block|abstain\nconfidence: low|medium|high\nveto: yes|no (skeptic only, otherwise no)\nreasons:\n- file:line evidence\nconditions: what would change your vote"
        }
      ],
      on: {
        voted: {
          to: "tally"
        },
        failed: {
          to: "tally"
        }
      }
    },
    tally: {
      kind: "decision",
      title: "Tally",
      role: "judge",
      prompt: "Project directory: {{inputs.dir}}\nQuestion: {{inputs.question}}\nBrief:\n{{results.frame.brief}}\nRound-1 ballots:\nSkeptic:\n{{results.vote.skeptic.text}}\nAuditor:\n{{results.vote.auditor.text}}\nPragmatist:\n{{results.vote.pragmatist.text}}\nDeliberation ballots, if present:\nSkeptic:\n{{results.deliberate.skeptic.text}}\nAuditor:\n{{results.deliberate.auditor.text}}\nPragmatist:\n{{results.deliberate.pragmatist.text}}\nHistory:\n{{run.history}}\nThis is tally visit {{visit}}.\nOn visit 1 tally round 1. On visit 2 tally only the deliberation ballots, not stale round-1 votes. A null ballot is a missing seat; the runner renders it as an empty ballot section. Missing deliberation on visit 1 is expected. Quorum is 2 of 3 seats. Count votes, not confidence. Only the skeptic may veto, and only for a concrete safety or data-loss issue it can point to. A veto: yes from the skeptic blocks and you may not override it. Majority approve means approved; majority block or no quorum means blocked. Otherwise choose split, allowed only on visit 1. On visit 2 you must choose approved or blocked; if there is still no majority approve, choose blocked.\nYou are read-only except for the decision ledger. Before firing, write ai-artifacts/council/{{inputs.slug}}/decision.md in {{inputs.dir}}. Create its parent directories if needed. Include the question, outcome, each ballot verbatim with its seat and round, your reasoning, and conditions. Mark missing seats explicitly. Do not change code or any other files. Return decision as one paragraph explaining the outcome and why.",
      on: {
        approved: {
          to: "approved"
        },
        blocked: {
          to: "blocked"
        },
        split: {
          to: "deliberate"
        }
      },
      output: {
        decision: {
          type: "string",
          required: true,
          description: "One paragraph: outcome and why"
        }
      },
      maxVisits: 2
    },
    blocked: {
      kind: "final",
      title: "Blocked",
      outcome: "failure"
    },
    deliberate: {
      kind: "fanout",
      title: "Deliberate",
      branches: [
        {
          id: "skeptic",
          role: "skeptic",
          prompt: "Project directory: {{inputs.dir}}\nBrief:\n{{results.frame.brief}}\n\nRound-1 ballots:\nSkeptic:\n{{results.vote.skeptic.text}}\nAuditor:\n{{results.vote.auditor.text}}\nPragmatist:\n{{results.vote.pragmatist.text}}\nRound 2: you have seen the other seats' ballots. Revise or hold your vote; say what changed your mind or why nothing did. Same ballot shape. You are read-only. Do not change anything. Check the brief against the real code and tests; run commands if it helps.\nLens: correctness and safety. Only you may veto, and only for a concrete safety or data-loss issue you can point to.\nReply with a ballot exactly in this shape:\nverdict: approve|block|abstain\nconfidence: low|medium|high\nveto: yes|no (skeptic only, otherwise no)\nreasons:\n- file:line evidence\nconditions: what would change your vote"
        },
        {
          id: "auditor",
          role: "auditor",
          prompt: "Project directory: {{inputs.dir}}\nBrief:\n{{results.frame.brief}}\n\nRound-1 ballots:\nSkeptic:\n{{results.vote.skeptic.text}}\nAuditor:\n{{results.vote.auditor.text}}\nPragmatist:\n{{results.vote.pragmatist.text}}\nRound 2: you have seen the other seats' ballots. Revise or hold your vote; say what changed your mind or why nothing did. Same ballot shape. You are read-only. Do not change anything. Check the brief against the real code and tests; run commands if it helps.\nLens: evidence. Do the tests prove the claims, what is untested, and does the diff match its description?\nReply with a ballot exactly in this shape:\nverdict: approve|block|abstain\nconfidence: low|medium|high\nveto: yes|no (skeptic only, otherwise no)\nreasons:\n- file:line evidence\nconditions: what would change your vote"
        },
        {
          id: "pragmatist",
          role: "pragmatist",
          prompt: "Project directory: {{inputs.dir}}\nBrief:\n{{results.frame.brief}}\n\nRound-1 ballots:\nSkeptic:\n{{results.vote.skeptic.text}}\nAuditor:\n{{results.vote.auditor.text}}\nPragmatist:\n{{results.vote.pragmatist.text}}\nRound 2: you have seen the other seats' ballots. Revise or hold your vote; say what changed your mind or why nothing did. Same ballot shape. You are read-only. Do not change anything. Check the brief against the real code and tests; run commands if it helps.\nLens: scope, simplicity and cost of ownership. Is this the smallest change, and what would it break for users?\nReply with a ballot exactly in this shape:\nverdict: approve|block|abstain\nconfidence: low|medium|high\nveto: yes|no (skeptic only, otherwise no)\nreasons:\n- file:line evidence\nconditions: what would change your vote"
        }
      ],
      on: {
        voted: {
          to: "tally"
        },
        failed: {
          to: "tally"
        }
      },
      maxVisits: 1
    }
  },
  whenToUse: "Before merging or deciding anything risky. Nothing in the council changes code.",
  inputs: {
    question: {
      type: "string",
      required: true,
      description: "The question the council must answer"
    },
    context: {
      type: "string",
      default: "the uncommitted diff and the files it touches",
      description: "What to look at"
    },
    slug: {
      type: "string",
      required: true,
      description: "Directory name under ai-artifacts/council"
    },
    dir: {
      type: "string",
      default: ".",
      description: "Project directory"
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
