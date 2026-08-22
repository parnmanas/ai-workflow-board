// Unit test — prompt-text regression guard for ticket 29ea479c's root cause
// (ticket ec498050).
//
// 29ea479c's repeated "계획 없이 구현 못함" refusal was NOT a code gate — it was
// pure role_prompt wording (`db.ts`'s BUILTIN_ROLES `assignee` text: "if the
// plan is missing or stale, ask the planner instead of improvising"). No
// runtime code path can regression-test that; the fix and its regression
// guard both live at the text level. This file asserts the forbidden
// ask-before-investigating phrasing is GONE from every prompt surface this
// ticket touched, and the self-investigate-first replacement is present.
//
// DB/Nest-free — imports the compiled dist modules directly and inspects
// their string content (same posture as consensus-state.test.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

const { BUILTIN_ROLES } = await import('file://' + path.join(DIST, 'db.js'));
const { DEFAULT_PROMPT_TEMPLATES } = await import(
  'file://' + path.join(DIST, 'database', 'default-prompt-templates.js')
);

// The exact forbidden shape ticket 29ea479c pinned: an instruction that tells
// an agent to ask/wait BEFORE trying to resolve something itself. Matches
// both the literal old assignee text and any future regression shaped like it.
const FORBIDDEN_ASK_INSTEAD_OF_INVESTIGATE = /ask (the )?planner instead of improvising/i;
const FORBIDDEN_RESOLVE_BY_ASKING_ONLY = /resolve them by @mentioning.*with a focused question — do not\s+guess/is;

function roleBySlug(slug) {
  const role = BUILTIN_ROLES.find((r) => r.slug === slug);
  assert.ok(role, `BUILTIN_ROLES must still have a "${slug}" entry`);
  return role;
}

function templateByName(name) {
  const tpl = DEFAULT_PROMPT_TEMPLATES.find((t) => t.name === name);
  assert.ok(tpl, `DEFAULT_PROMPT_TEMPLATES must still have a "${name}" entry`);
  return tpl;
}

test('BUILTIN_ROLES: assignee no longer tells the agent to ask instead of investigating', () => {
  const assignee = roleBySlug('assignee');
  assert.doesNotMatch(
    assignee.role_prompt, FORBIDDEN_ASK_INSTEAD_OF_INVESTIGATE,
    '29ea479c root cause phrase must not reappear in the assignee role_prompt',
  );
  assert.match(
    assignee.role_prompt, /investigate the codebase, git history, and ticket comments yourself first/i,
    'assignee role_prompt must carry the self-investigate-first replacement',
  );
  assert.match(
    assignee.role_prompt, /genuine design decision remains/i,
    'assignee role_prompt must scope planner questions to genuine design decisions, not any ambiguity',
  );
});

test('BUILTIN_ROLES: planner no longer tells the agent to ask before investigating', () => {
  const planner = roleBySlug('planner');
  assert.doesNotMatch(
    planner.role_prompt, FORBIDDEN_RESOLVE_BY_ASKING_ONLY,
    'planner role_prompt must not jump straight to "ask" without an investigate-first step',
  );
  assert.match(
    planner.role_prompt, /investigate the codebase, git history, and ticket comments yourself first/i,
    'planner role_prompt must carry the self-investigate-first replacement',
  );
});

test('BUILTIN_ROLES: reporter and reviewer were audited and are unchanged (already minimal guards)', () => {
  // No forbidden ask-first phrasing to begin with — this pins that the audit
  // did not introduce a NEW instance of the pattern into either role.
  for (const slug of ['reporter', 'reviewer']) {
    const role = roleBySlug(slug);
    assert.doesNotMatch(role.role_prompt, FORBIDDEN_ASK_INSTEAD_OF_INVESTIGATE, `${slug} role_prompt`);
  }
});

test('all 7 default workflow templates carry the investigate-before-asking rule', () => {
  for (const tpl of DEFAULT_PROMPT_TEMPLATES) {
    assert.match(
      tpl.content, /선\(先\) 조사 원칙/,
      `${tpl.name} must carry the 선(先) 조사 원칙 (investigate-before-asking) rule`,
    );
  }
  assert.equal(DEFAULT_PROMPT_TEMPLATES.length, 7, 'sanity — still exactly 7 default workflow templates');
});

test('todo_workflow: the Wait-branch / "don\'t bounce back" self-contradiction is resolved', () => {
  const content = templateByName('todo_workflow').content;
  // The two halves of the old contradiction must now agree: the concurrent-
  // work "Wait" branch explicitly says it does NOT need pend_ticket (it is
  // self-resolving), while the still-present "don't bounce back" note keeps
  // instructing pend_ticket for an actual human blocker — those are two
  // DIFFERENT situations now, not a flat contradiction on the same one.
  assert.match(
    content, /\*\*Wait\*\*.*do \*\*not\*\* `pend_ticket`.*self-resolving/is,
    'the concurrent-work Wait branch must explicitly disclaim pend_ticket as a self-resolving case',
  );
  assert.match(
    content, /Don't bounce a ticket back to wait.*pend_ticket/is,
    'the human-blocker pend_ticket note must still be present',
  );
});

test('todo_workflow: overlap Wait branch registers add_ticket_prerequisites, not just a comment (ticket eb4f09b6)', () => {
  const content = templateByName('todo_workflow').content;
  assert.match(
    content, /\*\*Wait\*\*.*add_ticket_prerequisites/is,
    'the concurrent-work Wait branch must call add_ticket_prerequisites to register the block, not just leave a comment',
  );
  assert.match(
    content, /human answer.*pend_ticket.*another ticket finishing.*add_ticket_prerequisites/is,
    'todo_workflow must state the human-vs-ticket rule of thumb for choosing prerequisite over pend_ticket',
  );
  assert.match(
    content, /auto-resumes.*terminal column.*re-triggered/is,
    'todo_workflow must explain the prerequisite auto-resume behavior once the blocking ticket lands on a terminal column',
  );
});

test('review_workflow: gained a pend_ticket / add_ticket_prerequisites escape hatch (was 0 occurrences)', () => {
  const content = templateByName('review_workflow').content;
  assert.match(content, /pend_ticket/, 'review_workflow must reference pend_ticket at least once');
  assert.match(content, /add_ticket_prerequisites/, 'review_workflow must reference add_ticket_prerequisites at least once');
  assert.match(content, /When to park/i, 'review_workflow must have a "when to park" section, mirroring the other columns');
});

test('merging_workflow: all 3 human-stop points now reference pend_ticket', () => {
  const content = templateByName('merging_workflow').content;
  const pendMentions = (content.match(/pend_ticket/g) || []).length;
  assert.ok(pendMentions >= 3, `merging_workflow must mention pend_ticket at its 3 human-stop points (found ${pendMentions})`);
});

test('ACTIONS_BEFORE_PENDING_RULE is present in exactly the 5 templates with a genuine pend_ticket decision point', () => {
  const withActions = ['todo_workflow', 'plan_workflow', 'in_progress_workflow', 'review_workflow', 'merging_workflow'];
  const withoutActions = ['backlog_workflow', 'done_workflow'];
  const marker = 'Actions — run a registered Action before you Pending';
  for (const name of withActions) {
    assert.match(templateByName(name).content, new RegExp(marker), `${name} must carry the Actions-before-Pending block`);
  }
  for (const name of withoutActions) {
    assert.doesNotMatch(
      templateByName(name).content, new RegExp(marker),
      `${name} has no pend_ticket decision point — the Actions block would be irrelevant bloat`,
    );
  }
});
