export const meta = {
  name: 'build',
  description: 'Coder builds an approved plan, two reviewers and the oracle agree fixes, a fresh coder applies them, QA proves it; reruns on QA failure',
  whenToUse: 'After Iury approves a plan produced by the plan workflow.',
  phases: [{ title: 'Build' }, { title: 'Review' }, { title: 'Agree' }, { title: 'Fix' }, { title: 'QA' }, { title: 'Report' }],
}

// args: { slug: string, scope?: string, builder?: string, dir?: string, checks?: string, retries?: number, verify?: 'feature' | 'refactor' | 'docs' }
// scope: one slice of the plan (e.g. "S2"). Build one slice per run; whole-plan briefs time out.
const slug = args?.slug
if (!slug) throw new Error('build needs args.slug (same as the plan run)')
const dir = args?.dir ?? '.'
const checks = args?.checks ?? 'the project check and test scripts in package.json'
const maxAttempts = 1 + (args?.retries ?? 2)
// verify: the method QA follows. Defaults to 'feature'; refactor and doc slices must pass it.
const verify = args?.verify ?? 'feature'
if (!['feature', 'refactor', 'docs'].includes(verify)) throw new Error("build: args.verify must be 'feature', 'refactor' or 'docs'")
const verifySkill = verify === 'docs' ? null : `${dir}/.pi/skills/${verify}-verification/SKILL.md`
const qaMethod = verifySkill
  ? { before: `Read ${verifySkill} and follow it. `, after: " Report in the skill's report format." }
  : { before: 'Check at least 5 factual claims against the source (file:line), run every command the doc tells a reader to run, and run npm run check:docs. For every changed ADR, check that each > quote greps to a > line in its cited evidence file, not to a ## heading. ', after: '' }
// Paths in briefs are read from the lead's cwd, so anchor them to dir.
const out = `${dir.replace(/\/+$/, '')}/ai-artifacts/workflows/${slug}`
const planFile = `the plan files in ${out}/`
const scope = args?.scope ?? null
// builder: agent type for coder and fresh-coder, e.g. 'designer' for UI slices.
const builder = args?.builder ?? 'coder'
const runTag = scope ? String(scope).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : 'full'
const reportFile = `${out}/run-report-${runTag}.html`
const scopeNote = scope ? `\nScope: implement ONLY slice ${scope} of the plan. Leave later slices alone.` : ''

// add_directory reloads the child's session and the reload reply replaces its answer
// ("Reload requested."), so a review of another worktree came back empty in 5 of 5 runs.
const DIR_RULE = dir === '.' ? '' : `\nWork in ${dir} with \`git -C ${dir}\` and paths under ${dir}. Do NOT call add_directory: it reloads your session and your answer is lost.`
const CITE = /[\w./-]+\.\w+:\d+/
const REVIEW_RULE = '\nReport findings with file:line. If you find nothing, still list the file:line ranges you checked. A reply with no file:line counts as a failed review. Flag any new or changed test that would still pass with the change removed, only checks that something exists, or asserts a mock returned its input (ai-artifacts/docs/adr/ADR-0007-tests-prove-behaviour.md).'
const TEST_RULE = '\nRun every test command under `timeout` (for example `timeout 300 npm test`). Any test or check that starts a server must close it. Do not commit; the lead commits.'

const UNTRACKED = {
  type: 'object',
  properties: { files: { type: 'array', items: { type: 'string' }, description: 'Untracked paths, exactly as git prints them' } },
  required: ['files'],
}
// Snapshot untracked files so a failed run can park only what it created.
const before = await agent(
  `Project directory: ${dir}${DIR_RULE}\nRun exactly \`git -C ${dir} status --porcelain --untracked-files=all\` and return the paths of lines starting with \`??\`. Change nothing.`,
  { agentType: 'qa', label: 'snapshot:untracked', schema: UNTRACKED, effort: 'low' },
)

const FIXES = {
  type: 'object',
  properties: {
    fixes: { type: 'string', description: 'Numbered list of agreed fixes with file:line and the change' },
    dropped: { type: 'string', description: 'Findings rejected and why' },
  },
  required: ['fixes', 'dropped'],
}
const QA = {
  type: 'object',
  properties: {
    passed: { type: 'boolean' },
    report: { type: 'string', description: 'Evidence for every check: command and output, or browser steps and result' },
  },
  required: ['passed', 'report'],
}

const history = []
let qa = null
let attempt = 0
let parked = null

while (attempt < maxAttempts) {
  attempt++
  const tag = `a${attempt}`
  const retryNote = qa
    ? `\n\nThis is attempt ${attempt}. The previous attempt's changes are already in the working tree. QA failed with this report; fix the causes:\n${qa.report}`
    : ''

  phase('Build')
  const built = await agent(
    `Project directory: ${dir}${DIR_RULE}\nRead the approved plan at ${planFile} and implement it.${scopeNote}${retryNote}\n\nRun ${checks} before you finish.${TEST_RULE} List the files you changed.`,
    { agentType: builder, label: `coder:${tag}` },
  )
  if (built === null) {
    history.push({ attempt, failed: 'coder' })
    // Park what the dead coder left so it cannot break the next gate (stray tests left servers open).
    const known = before?.files ?? null
    const parkDir = `${out}/attempt-${attempt}-${runTag}-orphans`
    parked = await agent(
      `Project directory: ${dir}${DIR_RULE}\nA coder agent died mid-run. Run \`git -C ${dir} status --porcelain --untracked-files=all\`. ` +
        (known ? `These untracked paths existed before the run; leave them alone:\n${known.join('\n') || '(none)'}\n` : 'The pre-run snapshot failed, so do not move anything; only list the untracked paths.\n') +
        `Move every other untracked path into ${parkDir}/ keeping its relative path, and append \`.txt\` to each moved file so no test runner picks it up. Do not touch tracked files; list modified tracked files separately. Then list (do NOT kill: other agents share this tree) test processes that may be left running, from \`ps -eo pid,etime,command | grep -E 'node --test|vitest|npm (run )?test'\`, with pid and elapsed time.`,
      { agentType: 'coder', label: `park:${tag}`, effort: 'low' },
    )
    break
  }

  const review = async (key, focus) => {
    const brief = `Project directory: ${dir}${DIR_RULE}\nPlan: ${planFile}\nCoder summary:\n${built}\n\n${scopeNote}\nReview the change for ${focus} Use git diff.${REVIEW_RULE}`
    let text = await agent(brief, { agentType: 'reviewer', label: `reviewer-${key}:${tag}`, phase: 'Review' })
    if (text === null || !CITE.test(text)) {
      log(`reviewer-${key}:${tag} named no file:line (${JSON.stringify(String(text).slice(0, 60))}); retrying once`)
      text = await agent(`${brief}\n\nYour previous reply cited no file:line, so it was rejected:\n${text}`, { agentType: 'reviewer', label: `reviewer-${key}-retry:${tag}`, phase: 'Review' })
    }
    return text !== null && CITE.test(text) ? text : null
  }
  const reviews = await parallel([
    () => review('a', 'CORRECTNESS: bugs, unhandled failures, invalid states, missing tests.'),
    () => review('b', 'DESIGN and FIT: does it match the plan and the codebase conventions, are names clear, is it the simplest change?'),
  ])
  if (reviews.some((r) => r === null)) {
    // A missing review is a failed run, never a clean one: stop before fix and QA treat silence as approval.
    history.push({ attempt, failed: 'review', built, reviews })
    log(`attempt ${attempt}: review failed (no file:line after retry)`)
    break
  }

  phase('Agree')
  const agreed = await agent(
    `Project directory: ${dir}${DIR_RULE}\nApproved plan: ${planFile}\n\nTwo reviewers looked at the same change.\n\nReviewer A:\n${reviews[0] ?? '(failed)'}\n\nReviewer B:\n${reviews[1] ?? '(failed)'}\n\n` +
      'Merge their findings. Keep what is real and in scope of the plan; drop the rest with a reason. Resolve conflicts against the plan.',
    { agentType: 'oracle', label: `oracle:${tag}`, schema: FIXES },
  )

  phase('Fix')
  const fixed = await agent(
    `Project directory: ${dir}${DIR_RULE}\nApproved plan: ${planFile}\nThe change is already in the working tree. ${scopeNote}\nApply ONLY these agreed fixes:\n${agreed?.fixes ?? '(oracle failed: re-check the reviews yourself)\n' + reviews.join('\n\n')}\n\nRun ${checks} before you finish.${TEST_RULE}`,
    { agentType: builder, label: `fresh-coder:${tag}` },
  )

  phase('QA')
  qa = await agent(
    `Project directory: ${dir}${DIR_RULE}\nApproved plan: ${planFile}${scopeNote}\n${qaMethod.before}Run ${checks}, then test the changed behaviour by hand. Decide pass or fail against the plan.${qaMethod.after}${TEST_RULE}`,
    { agentType: 'qa', label: `qa:${tag}`, schema: QA },
  )
  history.push({ attempt, built, reviews, agreed, fixed, qa })
  log(`attempt ${attempt}: QA ${qa?.passed ? 'passed' : 'failed'}`)
  if (qa?.passed) break
  if (qa === null) qa = { passed: false, report: 'QA agent failed to report.' }
}

phase('Report')
const passed = qa?.passed === true
const summary = history.map((h) =>
  `## Attempt ${h.attempt}\n` + (h.failed ? `Failed at ${h.failed}.` + (h.reviews ? `\n### Reviews (rejected: no file:line)\nA: ${h.reviews[0] ?? '(none)'}\nB: ${h.reviews[1] ?? '(none)'}` : '') :
    `### Coder\n${h.built}\n### Reviewer A\n${h.reviews[0]}\n### Reviewer B\n${h.reviews[1]}\n### Agreed fixes\n${h.agreed?.fixes}\n### Dropped\n${h.agreed?.dropped}\n### Fresh coder\n${h.fixed}\n### QA (${h.qa?.passed ? 'pass' : 'fail'})\n${h.qa?.report}`),
).join('\n\n') + (parked ? `\n\n## Parked orphans\n${parked}` : '')

await agent(
  (passed ? `QA passed. First update the project docs and the knowledge base that start at ai-artifacts/_index.md; if the change made a decision, add an ADR under ai-artifacts/docs/adr. Update what this change affects in ${dir}. Then write` : `QA did NOT pass after ${attempt} attempts. Do not update project docs. Write`) +
    ` ${reportFile}: a report of this build run for Iury. Show the outcome at the top (${passed ? 'PASSED' : 'FAILED'}), then the plan, each attempt, review findings and which were fixed, QA evidence, and anything left open.\n\nPlan file: ${planFile}\n\nRun log:\n${summary}`,
  { agentType: 'scribe', label: 'scribe:report' },
)

return { passed, attempts: attempt, scope, report: reportFile, parked, qa: qa?.report ?? null, failedAt: history.at(-1)?.failed ?? null }
