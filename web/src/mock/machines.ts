// Two example machines for VITE_MOCK=1, shaped like the playground fixtures (spec section 3).
import type { Machine, Role } from "../types.ts";

export const plan: Machine = {
  id: "plan",
  name: "Plan a change",
  description: "Lead drafts a plan, the oracle challenges it until it holds, the scribe explains it.",
  whenToUse: "Before building anything non-trivial.",
  inputs: {
    goal: { type: "string", required: true, description: "What the change should achieve" },
    slug: { type: "string", required: true, description: "Folder name under ai-artifacts/workflows" },
  },
  initial: "draft",
  states: {
    draft: {
      kind: "task", title: "Draft the plan", role: "lead",
      prompt: "Goal: {{inputs.goal}}\nWrite a plan to ai-artifacts/workflows/{{inputs.slug}}/plan.md.",
      output: { path: { type: "string", required: true, description: "Where the plan is" } },
      on: { drafted: { to: "challenge" } },
    },
    challenge: {
      kind: "decision", title: "Challenge the plan", role: "oracle",
      prompt: "Read {{results.draft.path}}. Approve it, or list the changes it needs.\n{{run.history}}",
      output: { changes: { type: "string", description: "What must change, if anything" } },
      on: { approved: { to: "explain", description: "The plan holds" }, changes: { to: "revise", description: "Something must change" } },
      maxVisits: 3,
    },
    revise: {
      kind: "task", title: "Revise the plan", role: "lead",
      prompt: "Apply these changes to the plan:\n{{results.challenge.changes}}",
      on: { revised: { to: "challenge" } },
      maxVisits: 3,
    },
    explain: {
      kind: "task", title: "Explain the plan", role: "scribe",
      prompt: "Write a one-page explainer of the approved plan for Iury.",
      on: { done: { to: "approved" } },
    },
    approved: { kind: "final", title: "Plan approved", outcome: "success" },
  },
};

export const build: Machine = {
  id: "build",
  name: "Build an approved plan",
  description: "Coder builds an approved plan, two reviewers and the oracle agree fixes, a fresh coder applies them, QA proves it; reruns on QA failure.",
  whenToUse: "After Iury approves a plan produced by the plan workflow.",
  inputs: {
    slug: { type: "string", required: true, description: "Same as the plan run" },
    dir: { type: "string", default: "." },
    retries: { type: "number", default: 2 },
  },
  initial: "build",
  states: {
    build: {
      kind: "task", title: "Build the plan", role: "coder",
      prompt: "Project: {{inputs.dir}}\nBuild the plan in ai-artifacts/workflows/{{inputs.slug}}/.\n{{results.qa.report}}",
      output: { summary: { type: "string", required: true, description: "Files changed" } },
      on: { built: { to: "review", description: "The change is in the working tree" } },
    },
    review: {
      kind: "fanout", title: "Two reviewers",
      branches: [
        { id: "a", role: "reviewer", prompt: "Review the change for CORRECTNESS.\n{{results.build.summary}}" },
        { id: "b", role: "reviewer", prompt: "Review the change for DESIGN.\n{{results.build.summary}}" },
      ],
      on: { done: { to: "agree" } },
    },
    agree: {
      kind: "task", title: "Agree the fixes", role: "oracle",
      prompt: "Reviewer A:\n{{results.review.a.text}}\n\nReviewer B:\n{{results.review.b.text}}\n\nAgree one list of fixes.",
      output: { fixes: { type: "string", required: true, description: "Numbered fixes with file:line" }, dropped: { type: "string", required: true, description: "Findings rejected and why" } },
      on: { agreed: { to: "fix" } },
    },
    fix: {
      kind: "task", title: "Apply the fixes", role: "coder",
      prompt: "Apply these fixes:\n{{results.agree.fixes}}",
      on: { fixed: { to: "qa" } },
    },
    qa: {
      kind: "decision", title: "Prove it", role: "qa",
      prompt: "Run the checks and prove the plan works.",
      output: { report: { type: "string", required: true, description: "Evidence for every check" } },
      on: { pass: { to: "report" }, fail: { to: "build", description: "Back to the coder" }, give_up: { to: "gave_up", description: "Out of retries" } },
    },
    report: {
      kind: "task", title: "Write the report", role: "scribe",
      prompt: "Summarise what was built and how it was proven.\n{{results.qa.report}}",
      on: { done: { to: "shipped" } },
    },
    shipped: { kind: "final", title: "Shipped", outcome: "success" },
    gave_up: { kind: "final", title: "Gave up", outcome: "failure" },
  },
};

export const roles: Role[] = [
  { name: "coder", description: "Implements scoped code changes and verifies them", color: "green", model: "openai-codex/gpt-6.1-sol", thinking: "high", tools: ["read", "bash", "grep", "find", "ls", "edit", "write"], skills: ["coding-standards"] },
  { name: "lead", description: "Plans and delegates", color: "blue", model: "claude-code/claude-opus-5-5", thinking: "medium", tools: ["read", "bash"], skills: [] },
  { name: "oracle", description: "Challenges and decides", color: "purple", model: "claude-code/claude-opus-5-5", thinking: "high", tools: ["read"], skills: [] },
  { name: "qa", description: "Proves a change works by running checks and testing by hand", color: "orange", model: "openai-codex/gpt-6-luna", thinking: "high", tools: ["read", "bash", "grep", "find", "ls"], skills: ["agent-browser"] },
  { name: "researcher", description: "Finds things out", color: "cyan", model: "openai-codex/gpt-6-luna", thinking: "high", tools: ["read", "bash"], skills: [] },
  { name: "reviewer", description: "Reviews changes", color: "red", model: "openai-codex/gpt-6-astra", thinking: "medium", tools: ["read", "bash", "grep"], skills: [] },
  { name: "scribe", description: "Writes it up", color: "yellow", model: "claude-code/claude-opus-5-5", thinking: "high", tools: ["read", "write"], skills: [] },
];

/** The prose under each mock role's frontmatter. */
export const roleBodies: Record<string, string> = {
  qa: "\nYou are the QA agent. Prove the change works.\n\n- Run the project's checks: typecheck, tests, build.\n- Then test by hand the way a user would.\n- Report what you ran and what you saw. Never say it works without evidence.\n",
  coder: "\nYou are the coder. Make the smallest change that solves the task, then verify it.\n",
  lead: "\nYou are the lead. Break the work down and hand each part to the right role.\n",
};
