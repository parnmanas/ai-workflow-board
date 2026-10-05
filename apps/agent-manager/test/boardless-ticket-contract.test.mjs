// Board-less tickets (docs/tickets.md) — the agent-manager side of the new
// `agent_trigger` contract, kept backward compatible with board (column) servers.
//
// New server: the trigger carries `status`, a `project` summary,
// `base_repo.main_clone_dir`, and `column_prompt` = the single-agent work order
// (`builtin:ticket-work-order`); `current_column_*` are derived from status and
// `effort_preset` is null. Old server: no status, real columns, column guides.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentContextPreflightError,
  buildAgentContextContract,
} from '../dist/lib/agent-context-contract.js';
import {
  composeTriggerPrompt,
  promptComposer,
  SINGLE_AGENT_EXECUTION_CONTRACT,
  TICKET_WORK_ORDER_TEMPLATE_ID,
} from '../dist/lib/prompts.js';
import { composePersistentTriggerTurn } from '../dist/lib/ticket-session-manager.js';
import { EventDispatcher } from '../dist/lib/event-dispatcher.js';
import { fetchRepositoryCredentialStatus } from '../dist/lib/rest.js';
import {
  columnFromStatus,
  isTicketStatusMove,
  parseTicketStatus,
  ticketWorkflowStatus,
} from '../dist/lib/ticket-status.js';

const TICKET_ID = '11111111-1111-4111-8111-111111111111';
const WORK_ORDER = {
  template_id: TICKET_WORK_ORDER_TEMPLATE_ID,
  name: 'Ticket work order',
  content: 'Understand, implement, verify, land, then move the ticket to done.',
};
const PROJECT = {
  id: 'project-1', name: 'Web', repo_url: 'https://github.com/acme/web.git',
  default_branch: 'main', use_pr: true, instructions: 'npm test before landing',
};
const BASE_REPO = {
  id: 'project-1', name: 'Web', url: 'https://github.com/acme/web.git',
  default_branch: 'main', main_clone_dir: '/srv/web',
};

// ── status helpers ───────────────────────────────────────────────────────────

test('ticket-status: parse, derived column, and the legacy-status guard', () => {
  assert.equal(parseTicketStatus(' In_Progress '), 'in_progress');
  assert.equal(parseTicketStatus('merging'), null);
  assert.deepEqual(columnFromStatus('done'), { id: 'status:done', name: 'Done', kind: 'terminal' });
  assert.deepEqual(columnFromStatus('review'), { id: 'status:review', name: 'Review', kind: 'active' });
  // The trigger stamp wins; a board ticket's legacy root status is never workflow state.
  assert.equal(ticketWorkflowStatus({ __awb_status: 'review', status: 'todo' }), 'review');
  assert.equal(ticketWorkflowStatus({ board_id: 'b', current_column_id: 'col-1', status: 'todo' }), null);
  assert.equal(ticketWorkflowStatus({ current_column_id: 'col-1', status: 'todo' }), null);
  // A board-less REST ticket (no board, no / derived column) is authoritative.
  assert.equal(ticketWorkflowStatus({ status: 'in_progress' }), 'in_progress');
  assert.equal(ticketWorkflowStatus({ status: 'in_progress', current_column_id: 'status:in_progress' }), 'in_progress');
});

test('isTicketStatusMove recognizes column moves and board-less status changes only', () => {
  assert.equal(isTicketStatusMove({ entity_type: 'ticket', action: 'moved' }), true);
  assert.equal(isTicketStatusMove({ entity_type: 'ticket', action: 'status_changed' }), true);
  assert.equal(isTicketStatusMove({ entity_type: 'ticket', action: 'updated', field_changed: 'status' }), true);
  assert.equal(isTicketStatusMove({ entity_type: 'ticket', action: 'updated', field_changed: 'title' }), false);
  assert.equal(isTicketStatusMove({ entity_type: 'comment', action: 'moved' }), false);
});

// ── Agent Context Contract ───────────────────────────────────────────────────

test('contract: status payload without column fields derives the column and omits boardId', () => {
  const contract = buildAgentContextContract({
    ticket: { id: TICKET_ID, account_id: 'ws-1', project_id: 'project-1', __awb_status: 'in_progress' },
    role: 'assignee',
  });
  assert.equal(contract.version, '1.3');
  assert.equal(contract.assignment.status, 'in_progress');
  assert.equal(contract.assignment.projectId, 'project-1');
  assert.equal('boardId' in contract.assignment, false, 'no empty boardId on a board-less ticket');
  assert.deepEqual(contract.assignment.column, { id: 'status:in_progress', name: 'In Progress', kind: 'active' });
});

test('contract: the server-derived column snapshot is kept verbatim next to status', () => {
  const contract = buildAgentContextContract({
    ticket: {
      id: TICKET_ID, __awb_status: 'todo',
      current_column_id: 'status:todo', current_column_name: 'To Do', current_column_kind: 'active',
    },
    role: 'assignee',
  });
  assert.equal(contract.assignment.status, 'todo');
  assert.deepEqual(contract.assignment.column, { id: 'status:todo', name: 'To Do', kind: 'active' });
});

test('contract: board tickets keep boardId and still fail closed without a column or status', () => {
  const board = buildAgentContextContract({
    ticket: { id: TICKET_ID, board_id: 'board-1', current_column_id: 'c', current_column_name: 'Review', status: 'todo' },
    role: 'reviewer',
  });
  assert.equal(board.assignment.boardId, 'board-1');
  assert.equal('status' in board.assignment, false, 'legacy root status is not reported as workflow state');
  assert.throws(
    () => buildAgentContextContract({ ticket: { id: TICKET_ID, board_id: 'board-1', status: 'todo' }, role: 'assignee' }),
    (error) => error instanceof AgentContextPreflightError && error.category === 'column',
  );
});

// ── Prompts ──────────────────────────────────────────────────────────────────

function statusTicket(overrides = {}) {
  return {
    id: TICKET_ID, title: 'Fix login', description: 'Users cannot log in.',
    __awb_status: 'in_progress', __awb_project: PROJECT, base_repo: BASE_REPO, base_branch: 'main',
    current_column_id: 'status:in_progress', current_column_name: 'In Progress', current_column_kind: 'active',
    ...overrides,
  };
}

test('status trigger prompt: single-agent contract, work order, status and project — no column wording', () => {
  const prompt = composeTriggerPrompt(statusTicket(), '', '', TICKET_ID, WORK_ORDER);
  assert.ok(prompt.includes(SINGLE_AGENT_EXECUTION_CONTRACT));
  assert.match(prompt, /own it end-to-end/);
  assert.match(prompt, /Finish by calling `mcp__awb__move_ticket` with status `done`, or `review`/);
  assert.match(prompt, /`mcp__awb__pend_ticket`/);
  assert.match(prompt, /may fan parts out to your own subagents/);
  assert.match(prompt, /Status: In Progress \(in_progress\)/);
  assert.match(prompt, /Ticket work order:\nUnderstand, implement, verify, land, then move the ticket to done\./);
  assert.match(prompt, /Project:\n- Name: Web\n- Repository: https:\/\/github.com\/acme\/web.git\n- Default branch: main\n- Base branch: main/);
  assert.match(prompt, /- Landing: open a pull request/);
  assert.match(prompt, /- Main clone folder on this host: \/srv\/web — the operator's checkout/);
  assert.match(prompt, /never commit, reset, clean, or switch branches there/);
  assert.match(prompt, /- Project instructions:\n {2}npm test before landing/);
  assert.match(prompt, /When the work is complete, move the ticket to `done`/);
  assert.match(prompt, /"status": "in_progress"/, 'the context contract carries the status');
  for (const legacy of [
    /current column workflow guide is the complete scope/i,
    /Current column:/,
    /Column workflow guide/,
    /next column/,
    /Claim the ticket/,
    /Base repository:/,
    /later column/,
  ]) {
    assert.doesNotMatch(prompt, legacy);
  }
});

test('ticket-less fallback still renders the work order when the template id says board-less', () => {
  const prompt = composeTriggerPrompt(null, '', 'Extra instructions', TICKET_ID, WORK_ORDER);
  assert.ok(prompt.includes(SINGLE_AGENT_EXECUTION_CONTRACT));
  assert.match(prompt, /Ticket work order:/);
  assert.doesNotMatch(prompt, /Column workflow guide|next column/);
});

test('column payloads (old server) keep the current-column contract unchanged', () => {
  const prompt = composeTriggerPrompt(
    {
      id: TICKET_ID, title: 'T', board_id: 'board-1', status: 'todo',
      current_column_id: 'column-1', current_column_name: 'Merging', current_column_kind: 'merging',
      base_repo: { id: 'repo-1', name: 'Repo', url: 'https://github.com/acme/repo.git', default_branch: 'main' },
    },
    '', '', TICKET_ID, { name: 'merging_workflow', content: 'Merge it.' },
  );
  assert.match(prompt, /current column workflow guide is the complete scope/i);
  assert.match(prompt, /Current column: Merging \(kind: merging, id: column-1\)/);
  assert.match(prompt, /Column workflow guide \(merging_workflow\):\nMerge it\./);
  assert.match(prompt, /Move the ticket to the next column when the work is complete\./);
  assert.match(prompt, /Base repository:/);
  assert.doesNotMatch(prompt, /Ticket work order|SINGLE|Status: /);
});

test('persistent follow-up turn speaks status + work order for a status trigger', () => {
  const turn = composePersistentTriggerTurn({
    ticketId: TICKET_ID, role: 'assignee', triggerId: 't-2', agentId: 'agent-1',
    rolePrompt: '', ticketPrompt: 'Also update the docs.', columnPrompt: WORK_ORDER,
    ticket: statusTicket({ __awb_enforce_context_contract: true }), forceRespawn: false,
  });
  assert.match(turn, /Status: In Progress \(in_progress\)/);
  assert.match(turn, /Ticket work order:/);
  assert.match(turn, /Updated instructions:\nAlso update the docs\./);
  assert.match(turn, /finish with mcp__awb__move_ticket to `done`/);
  assert.doesNotMatch(turn, /Current column:|Column workflow guide/);
});

// ── Repository credential: project path first, legacy resource path on 404 ───

let originalFetch;
beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

test('repository credential asks /projects/:id first and falls back to /resources/:id only on 404', async () => {
  const config = { url: 'http://awb.test', apiKey: 'k' };
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    if (String(url).includes('/projects/')) return new Response('not found', { status: 404 });
    return Response.json({ username: 'bot', token: 'tok' });
  };
  const legacy = await fetchRepositoryCredentialStatus(config, 'repo-1', 'agent-1', 'ws-1');
  assert.deepEqual(legacy, { credential: { username: 'bot', token: 'tok' }, failure: null });
  assert.deepEqual(seen, [
    'http://awb.test/api/agent-manager/projects/repo-1/git-credential?agent_id=agent-1&account_id=ws-1',
    'http://awb.test/api/agent-manager/resources/repo-1/git-credential?agent_id=agent-1&account_id=ws-1',
  ]);

  seen.length = 0;
  globalThis.fetch = async (url) => { seen.push(String(url)); return Response.json({ token: 'proj-tok' }); };
  const project = await fetchRepositoryCredentialStatus(config, 'project-1', 'agent-1');
  assert.deepEqual(project, { credential: { username: undefined, token: 'proj-tok' }, failure: null });
  assert.equal(seen.length, 1, 'the project path answered — no legacy request');

  // 204 (no credential configured) is an answer, not a reason to retry the alias.
  seen.length = 0;
  globalThis.fetch = async (url) => { seen.push(String(url)); return new Response(null, { status: 204 }); };
  assert.deepEqual(await fetchRepositoryCredentialStatus(config, 'project-1', 'agent-1'), { credential: null, failure: null });
  assert.equal(seen.length, 1);

  // Both paths 404 → a classified failure, never a silent "no credential".
  globalThis.fetch = async () => new Response('nope', { status: 404 });
  assert.deepEqual(await fetchRepositoryCredentialStatus(config, 'gone', 'agent-1'), { credential: null, failure: 'http_404' });
});

// ── Dispatcher end-to-end with a board-less agent_trigger ───────────────────

const AGENT = 'agent-boardless';

function agentContext() {
  return {
    agent_id: AGENT, name: 'Boardless', cli: 'claude', working_dir: '/workspace',
    mcp_config_path: '/config/mcp.json', api_key: 'agent-key', account_id: 'ws-1',
    cli_home_dir: '/cli-home', extra_env: {}, credential_provider: null, model: null,
    runtime_config: null,
  };
}

function boardlessTrigger(overrides = {}) {
  return JSON.stringify({
    event_type: 'agent_trigger',
    ticket_id: TICKET_ID,
    action: 'assignee',
    actor_name: AGENT,
    field_changed: 'trigger-1',
    trigger_source: 'dispatch',
    account_id: 'ws-1',
    status: 'in_progress',
    project: PROJECT,
    current_column_id: 'status:in_progress',
    current_column_name: 'In Progress',
    current_column_kind: 'active',
    column_prompt: WORK_ORDER,
    base_repo: BASE_REPO,
    base_branch: '',
    worktree_mode: 'per_ticket',
    effort_preset: null,
    ...overrides,
  });
}

function harness({ persistent }) {
  const calls = { resolve: [], tsm: [], spawn: [], credential: [], acks: [] };
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.includes('/git-credential?')) {
      calls.credential.push(target);
      return Response.json({ token: 'tok' });
    }
    if (target.includes('/api/agent/tickets/')) {
      // Board-less REST ticket: no board_id, no column — `status` is authoritative.
      return Response.json({
        id: TICKET_ID, title: 'Fix login', description: 'Users cannot log in.', account_id: 'ws-1',
        status: 'in_progress', project_id: 'project-1', comments: [],
        base_repo: { id: 'project-1', name: 'Web', url: 'https://github.com/acme/web.git', default_branch: 'main' },
      });
    }
    if (target.endsWith('/api/agent-manager/dispatch/ack')) {
      calls.acks.push(JSON.parse(init?.body || '{}'));
      return Response.json({});
    }
    return Response.json({});
  };
  const repositoryContext = {
    resourceId: 'project-1', cwd: '/srv/web/.awb/wt/11111111', baseBranch: 'main',
    baseSha: 'base-sha', currentSha: 'base-sha', workingBranch: `ticket/${TICKET_ID}-work`,
    dirty: false, ahead: 0, behind: 0, resumed: false,
  };
  const deps = {
    prompts: promptComposer,
    managedAgentContexts: {
      get: (id) => (id === AGENT ? agentContext() : null),
      has: (id) => id === AGENT,
      list: () => [agentContext()],
    },
    worktreeManager: {
      enabled: true,
      async resolveCwd(args) {
        calls.resolve.push(args);
        return { isWorktree: true, cwd: repositoryContext.cwd, mode: 'per_ticket', reused: false, repositoryContext };
      },
      async verifyCheckout() { return { ok: true }; },
      async verifyPushReadiness() { return { ok: true }; },
    },
    subagentManager: {
      canSpawn: () => true,
      async spawn(args) { calls.spawn.push(args); return { spawned: true, pid: 4242 }; },
    },
  };
  if (persistent) {
    deps.ticketSessionManager = {
      async dispatchTrigger(args) { calls.tsm.push(args); return { dispatched: true, pid: 4141, firstTurn: true }; },
    };
  }
  const dispatcher = new EventDispatcher(
    { url: 'http://awb.test', apiKey: 'test-key', delegation: { enabled: true, persistentTicketSessions: persistent } },
    deps,
  );
  return { dispatcher, calls };
}

async function waitFor(pred) {
  for (let i = 0; i < 100 && !pred(); i += 1) await new Promise((r) => setTimeout(r, 5));
  return pred();
}

test('dispatcher: status trigger → main clone bootstrap, project credential, status-stamped ticket (persistent)', async () => {
  const { dispatcher, calls } = harness({ persistent: true });
  await dispatcher.handleTrigger(boardlessTrigger());
  assert.equal(await waitFor(() => calls.tsm.length === 1), true, JSON.stringify(calls.acks));

  assert.equal(calls.resolve.length, 1);
  assert.equal(calls.resolve[0].mode, 'per_ticket');
  assert.deepEqual(calls.resolve[0].bootstrapRepo, {
    resourceId: 'project-1', url: 'https://github.com/acme/web.git', branch: 'main',
    credential: { username: undefined, token: 'tok' }, clonePolicy: null, mainCloneDir: '/srv/web',
  });
  assert.match(calls.credential[0], /\/api\/agent-manager\/projects\/project-1\/git-credential/);

  const args = calls.tsm[0];
  assert.equal(args.ticket.__awb_status, 'in_progress');
  assert.deepEqual(args.ticket.__awb_project, PROJECT);
  assert.deepEqual(args.ticket.base_repo, BASE_REPO, 'name + main_clone_dir survive the dispatcher rewrite');
  assert.equal(args.columnPrompt.template_id, TICKET_WORK_ORDER_TEMPLATE_ID);
  assert.equal(args.effortPreset, null);

  // The real first turn the session would get.
  const firstTurn = composeTriggerPrompt(args.ticket, '', args.ticketPrompt, TICKET_ID, args.columnPrompt, args.worktreeInstructions);
  assert.match(firstTurn, /Status: In Progress \(in_progress\)/);
  assert.match(firstTurn, /Main clone folder on this host: \/srv\/web/);
  assert.match(firstTurn, /"status": "in_progress"/);
  assert.doesNotMatch(firstTurn, /"boardId"/);
  assert.deepEqual(calls.acks.map((a) => a.outcome), ['processed']);
});

test('dispatcher: status trigger one-shot prompt and runtime effort (effort_preset null)', async () => {
  const { dispatcher, calls } = harness({ persistent: false });
  const raw = JSON.parse(boardlessTrigger());
  raw.runtime = {
    manager_agent_id: 'host-1', cli: 'claude', model: null, working_dir: '/workspace',
    folder_scope: 'shared', credential_id: null, runtime_config: { extra: { effort: 'high' } },
  };
  await dispatcher.handleTrigger(JSON.stringify(raw));
  assert.equal(await waitFor(() => calls.spawn.length === 1), true, JSON.stringify(calls.acks));
  const spawn = calls.spawn[0];
  assert.ok(spawn.taskText.includes(SINGLE_AGENT_EXECUTION_CONTRACT));
  assert.match(spawn.taskText, /Ticket work order:/);
  assert.doesNotMatch(spawn.taskText, /Column workflow guide|next column/);
  assert.equal(spawn.effortPreset, null);
  // Effort rides the RuntimeSpec into the spawn context (→ `--effort`, see
  // permission-spawn-wiring) and the context contract reports it.
  assert.equal(spawn.agentContext.runtime_config.extra.effort, 'high');
  assert.match(spawn.taskText, /"effort": "high"/);
});

for (const persistent of [true, false]) {
  test(`dispatcher: legacy owner field preserves project credential scope (${persistent ? 'persistent' : 'one-shot'})`, async () => {
    const { dispatcher, calls } = harness({ persistent });
    await dispatcher.handleTrigger(boardlessTrigger({ account_id: undefined, workspace_id: 'ws-1' }));
    assert.equal(await waitFor(() => (persistent ? calls.tsm : calls.spawn).length === 1), true, JSON.stringify(calls.acks));
    assert.ok(calls.credential.length > 0);
    for (const url of calls.credential) {
      assert.equal(new URL(url).searchParams.get('account_id'), 'ws-1');
      assert.equal(new URL(url).searchParams.has('workspace_id'), false);
    }
    assert.deepEqual(calls.acks.map((ack) => ack.outcome), ['processed']);
  });
}

test('dispatcher: an old board trigger (no status) keeps the column contract', async () => {
  const { dispatcher, calls } = harness({ persistent: false });
  await dispatcher.handleTrigger(boardlessTrigger({
    status: undefined,
    project: undefined,
    current_column_id: 'column-progress',
    current_column_name: 'In Progress',
    column_prompt: { template_id: 'tmpl-1', name: 'in_progress_workflow', content: 'Implement, then hand off to Review.' },
    base_repo: { id: 'repo-1', name: 'Repo', url: 'https://github.com/acme/web.git', default_branch: 'main' },
  }));
  assert.equal(await waitFor(() => calls.spawn.length === 1), true, JSON.stringify(calls.acks));
  assert.equal(calls.resolve[0].bootstrapRepo.mainCloneDir, null);
  assert.match(calls.spawn[0].taskText, /current column workflow guide is the complete scope/i);
  assert.match(calls.spawn[0].taskText, /Column workflow guide \(in_progress_workflow\)/);
  assert.match(calls.spawn[0].taskText, /Current column: In Progress/);
});
