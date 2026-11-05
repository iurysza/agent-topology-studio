import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { runWorkflow } from '../test/fake-host.js';
const code = await readFile(new URL('../fixtures/playground/.pi/workflows/council.js', import.meta.url), 'utf8');
const destination = new URL('../fixtures/runs/', import.meta.url);
const ballot = (verdict, veto = 'no') => `verdict: ${verdict}\nconfidence: high\nveto: ${veto}\nreasons:\n- example.js:1 verified evidence\nconditions: none`;
const yes = ballot('approve'), no = ballot('block'), abstain = ballot('abstain');
const cases = [
  { name: 'approve', rounds: [[yes, yes, yes]], expected: { outcome: 'success', history: ['frame → framed', 'vote → voted', 'tally → approved'], calls: 5 } },
  { name: 'veto', rounds: [[ballot('block', 'yes'), yes, yes]], expected: { outcome: 'failure', history: ['frame → framed', 'vote → voted', 'tally → blocked'], calls: 5 } },
  { name: 'split', rounds: [[no, yes, abstain], [yes, yes, no]], expected: { outcome: 'success', history: ['frame → framed', 'vote → voted', 'tally → split', 'deliberate → voted', 'tally → approved'], calls: 9 } },
  { name: 'quorum', rounds: [[yes, null, yes]], expected: { outcome: 'success', history: ['frame → framed', 'vote → failed', 'tally → approved'], calls: 5 } },
];
// Run and check every case before writing anything, so a failed assert leaves fixtures/runs untouched.
const outputs = [];
for (const scenario of cases) {
  const entries = [];
  let n = 0;
  const result = await runWorkflow(code, {
    args: { question: 'Can this merge?', slug: `dry-${scenario.name}` },
    agent: async (prompt, options) => {
      const index = n++, [state, seat] = options.label.split(':');
      let answer;
      if (state === 'frame') answer = { event: 'framed', brief: 'Check safety, tests and user impact against example.js:1.' };
      else if (state === 'vote' || state === 'deliberate') answer = scenario.rounds[state === 'vote' ? 0 : 1][['skeptic', 'auditor', 'pragmatist'].indexOf(seat)];
      else {
        const round = scenario.rounds[seat === '2' ? 1 : 0], votes = round.filter(Boolean);
        const event = votes.length < 2 || round[0]?.includes('veto: yes') ? 'blocked'
          : votes.filter(text => text.startsWith('verdict: approve\n')).length >= 2 ? 'approved'
          : votes.filter(text => text.startsWith('verdict: block\n')).length >= 2 || seat === '2' ? 'blocked' : 'split';
        answer = { event, decision: `${event}: scripted ballot tally` };
      }
      const canonical = [prompt, options.label ?? null, null, options.agentType ?? null, null, null, null, null, ...(options.schema ? [JSON.stringify(options.schema)] : [])];
      const key = createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 32);
      entries.push({ index, key, ok: answer !== null, ...(answer !== null ? { text: typeof answer === 'string' ? answer : JSON.stringify(answer) } : {}) });
      return answer;
    },
  });
  assert.deepEqual({ outcome: result.outcome, history: result.history, calls: entries.length }, scenario.expected, `${scenario.name} run`);
  outputs.push([scenario.name, entries]);
}
const serialize = values => values.map(entry => JSON.stringify(entry) + '\n').join('');
await mkdir(destination, { recursive: true });
for (const [name, entries] of outputs) {
  await writeFile(new URL(`council-${name}.workflow.jsonl`, destination), serialize(entries));
  if (name === 'approve') await writeFile(new URL('council-partial.workflow.jsonl', destination), serialize(entries.slice(0, 3)));
}
