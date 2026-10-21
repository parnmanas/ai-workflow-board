// Pure helpers behind the board-less ticket model (docs/tickets.md):
//   - common/ticket-status.ts — the fixed status set, the lenient parser that
//     maps old column names onto it, and the legacy column projection older
//     agent-managers still require on agent_trigger / board_update;
//   - common/ticket-work-order.ts — the single-agent work order every dispatch
//     carries in column_prompt.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  TICKET_STATUSES,
  parseTicketStatus,
  isTicketPending,
  statusColumnProjection,
} = await import('../dist/common/ticket-status.js');
const { renderTicketWorkOrder, renderChildTicketsSection, TICKET_WORK_ORDER_TEMPLATE_ID } = await import('../dist/common/ticket-work-order.js');
const { normalizeTags } = await import('../dist/modules/tickets/ticket.service.js');

test('the status set is fixed and ordered', () => {
  assert.deepEqual([...TICKET_STATUSES], ['backlog', 'todo', 'in_progress', 'review', 'done']);
});

test('old column names and labels parse onto the fixed set; anything else is rejected', () => {
  assert.equal(parseTicketStatus('In Progress'), 'in_progress');
  assert.equal(parseTicketStatus('in-progress'), 'in_progress');
  assert.equal(parseTicketStatus('To Do'), 'todo');
  assert.equal(parseTicketStatus('Plan'), 'todo');
  assert.equal(parseTicketStatus('Merging'), 'in_progress');
  assert.equal(parseTicketStatus('Done'), 'done');
  assert.equal(parseTicketStatus('REVIEW'), 'review');
  assert.equal(parseTicketStatus('Backlog'), 'backlog');
  assert.equal(parseTicketStatus('blocked'), null);
  assert.equal(parseTicketStatus(''), null);
  assert.equal(parseTicketStatus(undefined), null);
});

test('any pending flag parks a ticket', () => {
  assert.equal(isTicketPending({}), false);
  assert.equal(isTicketPending({ pending_user_action: true }), true);
  assert.equal(isTicketPending({ pending_on_tickets: true }), true);
  assert.equal(isTicketPending({ pending_ci_wait: true }), true);
});

test('the legacy column projection keeps old managers dispatching', () => {
  assert.deepEqual(statusColumnProjection('in_progress'), {
    current_column_id: 'status:in_progress', current_column_name: 'In Progress', current_column_kind: 'active',
  });
  // Old managers clean up worktrees when a ticket lands on a terminal column.
  assert.equal(statusColumnProjection('done').current_column_kind, 'terminal');
  assert.equal(statusColumnProjection('backlog').current_column_kind, 'intake');
  assert.equal(statusColumnProjection('review').current_column_kind, 'review');
});

test('tags are trimmed, de-duplicated case-insensitively and bounded', () => {
  assert.deepEqual(normalizeTags([' GameClient ', 'gameclient', 'bug', '', null]), ['GameClient', 'bug']);
  assert.deepEqual(normalizeTags('a, b ,a'), ['a', 'b']);
  assert.deepEqual(normalizeTags('["x","y"]'), ['x', 'y']);
  assert.equal(normalizeTags(Array.from({ length: 50 }, (_, i) => `t${i}`)).length, 30);
});

test('the work order names the project, its main clone and the landing policy', () => {
  const direct = renderTicketWorkOrder({
    base_branch: '',
    project: {
      name: 'GameClient', repo_url: 'https://github.com/example/gc', default_branch: 'master',
      use_pr: false, instructions: 'Run `npm test` before landing.', main_clone_dir: '/srv/gc',
    },
  });
  assert.match(direct, /only agent on this ticket/);
  assert.match(direct, /Project: GameClient/);
  assert.match(direct, /Base branch: master/);
  assert.match(direct, /\/srv\/gc/);
  assert.match(direct, /Run `npm test` before landing\./);
  assert.match(direct, /merges directly/);
  assert.doesNotMatch(direct, /gh pr create/);
  assert.match(direct, /move_ticket\(status: "done"\)/);
  assert.match(direct, /move_ticket\(status: "review"\)/);

  const pr = renderTicketWorkOrder({
    base_branch: 'release',
    project: { name: 'P', repo_url: 'u', default_branch: 'main', use_pr: true, instructions: '', main_clone_dir: null },
  });
  assert.match(pr, /gh pr create/);
  assert.match(pr, /Base branch: release/);
  assert.match(pr, /no registered main clone/);
});

test('the work order spells out how to work child tickets and lists the open ones by id', () => {
  // A ticket split into 8 checklist children finished all 8 stages with every child still todo (822e54d6) —
  // the order said "a checklist you work through" but never how or when to close an item.
  const none = renderTicketWorkOrder({ base_branch: '', project: null });
  assert.match(none, /## Child tickets \(your checklist\)/);
  assert.match(none, /never dispatched: you do every one of them yourself/);
  assert.match(none, /Close each item as soon as its part is implemented and verified/);
  assert.match(none, /update_child_ticket\(status: "done"\)`\. One at a time as you go — never in a batch at the end/);
  assert.match(none, /Do not pass `force`/);
  assert.match(none, /no child tickets yet/);
  assert.match(none, /Every child ticket is already `done`/, 'the finish step checks the list');
  assert.ok(none.indexOf('## Child tickets') < none.indexOf('## 1. Understand'), 'read before the steps');

  const some = renderTicketWorkOrder({
    base_branch: '', project: null,
    children: [
      { id: 'c-1', title: '1. Server', status: 'done' },
      { id: 'c-2', title: '2. Screens', status: 'todo' },
      { id: 'c-3', title: '3. Docs', status: 'in_progress' },
    ],
  });
  assert.match(some, /This ticket has 3 child tickets; 2 still open — they are your remaining scope:\n- `c-2` 2\. Screens\n- `c-3` 3\. Docs/);
  assert.doesNotMatch(some, /`c-1`/, 'done items are not listed');

  const done = renderChildTicketsSection([{ id: 'c-1', title: 'x', status: 'done' }]);
  assert.match(done, /All 1 child tickets of this ticket are done\./);
  const many = renderChildTicketsSection(Array.from({ length: 35 }, (_, i) => ({ id: `c-${i}`, title: `t${i}`, status: 'todo' })));
  assert.match(many, /- …and 5 more/);
});

test('a ticket without a project skips the git steps', () => {
  const text = renderTicketWorkOrder({ base_branch: '', project: null });
  assert.match(text, /not about a repository/);
  assert.match(text, /Nothing to land/);
  assert.equal(TICKET_WORK_ORDER_TEMPLATE_ID, 'builtin:ticket-work-order');
});
