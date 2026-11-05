import { gateSource } from './gate.ts';

export const runner = `const inputs = {}
for (const [k, f] of Object.entries(machine.inputs ?? {})) {
  const v = args?.[k] === undefined ? f.default : args[k]
  const reason = v === undefined && f.required ? \`\${machine.id} needs args.\${k}: \${f.description ?? f.type}\` : v !== undefined && ['number', 'boolean', 'string', 'array'].includes(f.type) && (f.type === 'array' ? !Array.isArray(v) : typeof v !== f.type || (f.type === 'number' && !Number.isFinite(v))) ? \`\${machine.id} args.\${k} must be \${f.type}\` : null
  if (reason) return { outcome: 'failure', reason, at: machine.initial, history: [], results: Object.create(null) }
  inputs[k] = v
}
const results = Object.create(null), history = [], visits = Object.create(null)
const get = (path) => path.split('.').reduce((o, k) => (o == null || !Object.hasOwn(o, k) ? undefined : o[k]), { inputs, results, run: { history: history.join('\\n') } })
const fill = (tpl, extra, word = (v) => v) => tpl.replace(/\\{\\{\\s*([\\w.]+)\\s*\\}\\}/g, (_, p) => { const v = p === 'visit' ? extra.visit : get(p); return word(v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v)) }); ${gateSource}; for (const [where, gate] of Object.entries(machine.states).flatMap(([id, s]) => [[id, s.gate], ...(s.branches ?? []).map((b) => [\`\${id} branch \${b.id}\`, b.gate])])) { const problem = typeof gate === 'string' && gateProblem(gate); if (problem) return { outcome: 'failure', reason: \`\${where} gate \${problem}\`, at: machine.initial, history: [], results: Object.create(null) } }
const schemaFor = (s) => {
  const props = { event: { type: 'string', enum: Object.keys(s.on), description: Object.entries(s.on).map(([e, t]) => \`\${e}: \${t.description ?? '→ ' + t.to}\`).join('; ') } }
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
  if (visits[at] > max) { reason = \`\${at} ran \${max} times without reaching an end\`; break }
  phase(s.title, { at, visits: { ...visits } })
  let event
  if (s.kind === 'fanout') {
    const out = await parallel(s.branches.map((b) => async () => { try { return await agent(fill(b.prompt, { visit: visits[at] }), { agentType: b.role, label: \`\${at}:\${b.id}\`, phase: s.title, ...(b.gate ? { gate: fill(b.gate, { visit: visits[at] }, shellWord) } : {}) }) } catch (e) { log(\`\${at}:\${b.id} failed: \${e?.message ?? e}\`); return null } }))
    results[at] = Object.fromEntries(s.branches.map((b, i) => [b.id, out[i] == null ? null : { text: out[i] }]))
    const failed = s.branches.find((b, i) => out[i] == null)
    if (failed && !Object.hasOwn(s.on, 'failed')) { reason = \`\${at}: branch \${failed.id} failed\`; break }
    event = failed ? 'failed' : Object.keys(s.on).find(e => e !== 'failed')
  } else {
    let r; try { r = await agent(fill(s.prompt, { visit: visits[at] }), { agentType: s.role, label: visits[at] > 1 ? \`\${at}:\${visits[at]}\` : at, schema: schemaFor(s), ...(s.gate ? { gate: fill(s.gate, { visit: visits[at] }, shellWord) } : {}) }) } catch (e) { if (!s.gate || !Object.hasOwn(s.on, 'failed')) { reason = \`\${at} failed: \${e?.message ?? e}\`; break } log(\`\${at} failed: \${e?.message ?? e}\`); r = null }
    if (s.gate && r === null && Object.hasOwn(s.on, 'failed')) r = { event: 'failed' }
    event = r !== null && typeof r === 'object' && !Array.isArray(r) ? r.event : r
    if (r === null || typeof r !== 'object' || Array.isArray(r) || typeof event !== 'string' || !Object.hasOwn(s.on, event)) { reason = r === null ? \`\${at}: agent failed\` : \`\${at}: unknown event \${event !== null && typeof event === 'object' ? JSON.stringify(event) : event}\`; break }
    results[at] = r
  }
  history.push(\`\${at} → \${event}\`)
  log(\`\${at} → \${event}\`, { at, event, to: s.on[event].to, result: results[at] })
  at = s.on[event].to
}
return { outcome, reason, at, history, results, visits }
`;
