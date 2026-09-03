// Integration test — CLI workspace-trust / provider-auth dispatch preflight
// (ticket 48aeab6e).
//
// Background: a planner dispatch repeatedly failed before doing any real
// work because the checked-out CLI workspace wasn't trust-approved and/or the
// provider OAuth session was expired with no refresh token, while the
// assignee sat idle across multiple supervisor cycles. This proves the fix
// end-to-end through the REAL EventDispatcher (mirrors
// provisioning-block-pend.test.mjs's harness style: a stateful /mcp mock so
// pend_ticket/unpend_ticket actually flip pending_user_action, and a fake
// subagentManager so no real CLI process is ever spawned):
//   (1) interactive trust required — a board harness `permission_mode` other
//       than `bypassPermissions` makes Claude Code's trust dialog load-
//       bearing; an unapproved cli-home pends on the FIRST abort, spawns
//       nothing, de-dupes the comment/pend on repeat, and recovers once the
//       operator records trust approval;
//   (2) expired, unrenewable OAuth token — a `.credentials.json` with a past
//       `expiresAt` and no `refreshToken` pends the same way and recovers
//       once a live credential is written;
//   (3) control — the common case (no board harness override) is completely
//       unaffected: an untrusted cli-home never blocks anything under the
//       default `--dangerously-skip-permissions`.
//
// The adapter itself is NOT mocked (createAdapter() is called directly
// inside EventDispatcher, same as production) — trust/auth state is instead
// driven through real files in a real temp cli-home dir, exactly like
// claude-adapter.test.mjs's own readTrustMeta/readCredentialMeta fixtures.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventDispatcher } from '../dist/lib/event-dispatcher.js';
import { _drainTrustSeedLocksForTests } from '../dist/lib/cli-adapters/claude.js';

const AGENT = 'agent-rolf';
const TICKET = 'ticket-cli-readiness';
const CWD = '/ws/.awb/wt/ok';

const tempDirs = [];

async function makeCliHomeDir() {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'cli-readiness-home-'));
  tempDirs.push(dir);
  return dir;
}

function makeCtx(cliHomeDir, runtimeConfig = null) {
  return {
    agent_id: AGENT,
    name: 'Rolf',
    cli: 'claude',
    working_dir: '/ws',
    mcp_config_path: '/cfg/mcp.json',
    api_key: 'k',
    cli_home_dir: cliHomeDir,
    extra_env: {},
    credential_provider: null,
    model: null,
    // ticket 5851e435 — Agent trust. null = trust 미설정(legacy agent), 그
    // 경우 게이트는 종전대로 harness permission_mode 만 보고 판단한다.
    runtime_config: runtimeConfig,
  };
}

let originalFetch;
let mcpToolCalls; // names of tools/call invoked over /mcp (add_comment, pend_ticket, …)
let addCommentContents; // ticket 48aeab6e review: preserved `content` arg of each add_comment call, in order
let ticketState;  // the (mocked) server-side ticket row the pend/unpend transition mutates

beforeEach(() => {
  originalFetch = globalThis.fetch;
  mcpToolCalls = [];
  addCommentContents = [];
  ticketState = {
    id: TICKET, current_column_id: 'column-active', current_column_name: '진행 중',
    current_column_kind: 'active', comments: [], pending_user_action: false,
  };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const method = init?.method || 'GET';
    if (u.endsWith('/mcp')) {
      if (method === 'DELETE') return new Response('{}', { status: 200 });
      const body = init?.body ? JSON.parse(init.body) : {};
      if (body.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
          status: 200,
          headers: { 'mcp-session-id': 'sid-test', 'content-type': 'application/json' },
        });
      }
      if (body.method === 'tools/call') {
        const name = body.params?.name;
        mcpToolCalls.push(name);
        // Stateful boundary, same as provisioning-block-pend.test.mjs: the
        // manager's pend_ticket call actually flips the server ticket's
        // pending flag (and unpend clears it).
        if (name === 'pend_ticket') ticketState.pending_user_action = true;
        if (name === 'unpend_ticket') ticketState.pending_user_action = false;
        if (name === 'add_comment') addCommentContents.push(body.params?.arguments?.content ?? '');
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '{}' }] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('', { status: 202 }); // notifications/initialized, etc.
    }
    if (u.includes('/api/agent/tickets/')) {
      return new Response(JSON.stringify(ticketState), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  // ticket 152e3606: bypassPermissions 티켓 디스패치는 워크스페이스 trust를
  // fire-and-forget으로 시딩한다 — 임시 cli-home 디렉터리를 지우기 전에
  // 그 백그라운드 쓰기를 먼저 드레인해야, 삭제 도중 새 파일이 생겨
  // ENOTEMPTY가 나는 레이스를 피할 수 있다.
  await _drainTrustSeedLocksForTests();
  await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

function makeSubagentManager(state) {
  return {
    canSpawn: () => true,
    async spawn(spec) {
      state.spawns.push(spec);
      return { spawned: true, pid: 4321 };
    },
  };
}

function makeDispatcher(state, cliHomeDir, runtimeConfig = null) {
  const worktreeManager = {
    enabled: true,
    async resolveCwd() {
      return {
        isWorktree: true, cwd: CWD, mode: 'per_ticket', reused: false,
        repositoryContext: {
          resourceId: 'repo-1', cwd: CWD, baseBranch: 'main', baseSha: 'base-sha',
          currentSha: 'head-sha', workingBranch: 'ticket/readiness-work', dirty: false,
          ahead: 0, behind: 0, resumed: false,
        },
      };
    },
    async verifyCheckout() { return { ok: true }; },
    async verifyPushReadiness() { return { ok: true }; },
    async removeTicketWorktrees() { return 0; },
    async removeTicketRunWorkspace() { return false; },
  };
  const managedAgentContexts = {
    get: (id) => (id === AGENT ? makeCtx(cliHomeDir, runtimeConfig) : null),
    has: (id) => id === AGENT,
    list: () => [{ working_dir: '/ws' }],
  };
  // No ticketSessionManager → the dispatcher falls to the one-shot subagent
  // path, whose spawn() (our fake) we count.
  return new EventDispatcher(
    { url: 'http://127.0.0.1:0', apiKey: 'test-key', delegation: { enabled: true } },
    { worktreeManager, subagentManager: makeSubagentManager(state), managedAgentContexts },
  );
}

function newState() {
  return { spawns: [] };
}

function makeEvent(overrides = {}) {
  return JSON.stringify({
    event_type: 'agent_trigger',
    ticket_id: TICKET,
    action: 'assignee',
    actor_name: AGENT,
    field_changed: 'trig',
    trigger_source: 'column_move', // non-supervisor by default (always runs preflight)
    current_column_id: 'column-active',
    current_column_name: '진행 중',
    current_column_kind: 'active',
    base_repo: { id: 'repo-1', url: 'https://github.com/acme/app.git', default_branch: 'main' },
    base_branch: 'main',
    ...overrides,
  });
}

const countTool = (name) => mcpToolCalls.filter((n) => n === name).length;

// ── (1) interactive trust required ──────────────────────────────────────────

test('unapproved workspace trust under a non-bypass permission_mode pends on the first abort, spawns nothing, dedupes, and recovers', async () => {
  const cliHomeDir = await makeCliHomeDir(); // empty — no .claude.json written yet
  const state = newState();
  const d = makeDispatcher(state, cliHomeDir);
  // A board harness permission_mode other than bypassPermissions drops
  // --dangerously-skip-permissions, making the trust dialog load-bearing.
  const harness_config = { permission_mode: 'default' };

  await d.handleTrigger(makeEvent({ harness_config, field_changed: 'a1' }));

  assert.equal(state.spawns.length, 0, 'no strand spawned while workspace trust is unapproved');
  assert.equal(countTool('pend_ticket'), 1, 'a durable CLI-trust blocker pends on the FIRST abort');
  assert.equal(countTool('add_comment'), 1, 'the abort posts a single actionable ticket comment');
  assert.equal(ticketState.pending_user_action, true, 'the pend transition actually set pending_user_action');

  // Review (48aeab6e): pend_ticket suppresses supervisor auto-retrigger, so
  // "fix trust then re-trigger" alone is a dead end — the comment must also
  // tell the operator to unpend/Resume before a retrigger can do anything.
  assert.match(
    addCommentContents[0],
    /unpend/i,
    'the trust blocker comment must name the unpend step, not just the trust fix — pend_ticket already suppressed auto-retrigger',
  );
  assert.match(
    addCommentContents[0],
    /Resume/,
    'the trust blocker comment should point at the User-tab ▶ Resume affordance an operator actually sees, not just the raw MCP tool name',
  );

  // Repeated re-trigger while still untrusted must NOT repeat the comment/pend
  // — this is the "trust/credential 상태가 바뀔 때까지 반복 redispatch를
  // 억제" requirement.
  await d.handleTrigger(makeEvent({ harness_config, trigger_source: 'supervisor', field_changed: 'sup1' }));
  assert.equal(state.spawns.length, 0, 'still no spawn while untrusted');
  assert.equal(countTool('pend_ticket'), 1, 'no duplicate pend while the trust state has not changed');
  assert.equal(countTool('add_comment'), 1, 'no duplicate comment while the trust state has not changed');

  // Operator fix: accept the trust dialog for this exact cwd (the same file/key
  // Claude Code's own stderr names), then unpend.
  await fsp.writeFile(
    join(cliHomeDir, '.claude.json'),
    JSON.stringify({ projects: { [CWD]: { hasTrustDialogAccepted: true } } }),
  );
  ticketState.pending_user_action = false;
  await d.handleTrigger(makeEvent({ harness_config, field_changed: 'recover' }));

  assert.equal(state.spawns.length, 1, 'recovery spawned exactly one strand once trust was approved');
});

test('trust required + explicit bypassPermissions mode never blocks (same effect as the default skip flag)', async () => {
  const cliHomeDir = await makeCliHomeDir(); // untrusted
  const state = newState();
  const d = makeDispatcher(state, cliHomeDir);

  await d.handleTrigger(makeEvent({ harness_config: { permission_mode: 'bypassPermissions' }, field_changed: 'a1' }));

  assert.equal(state.spawns.length, 1, 'bypassPermissions never surfaces the trust dialog — untrusted cli-home is irrelevant');
  assert.equal(countTool('pend_ticket'), 0);
});

// ── (2) expired, unrenewable OAuth session ──────────────────────────────────

test('an expired OAuth credential with no refresh token pends on the first abort, spawns nothing, and recovers', async () => {
  const cliHomeDir = await makeCliHomeDir();
  await fsp.writeFile(
    join(cliHomeDir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'x', expiresAt: Date.now() - 60_000, refreshToken: '' } }),
  );
  const state = newState();
  const d = makeDispatcher(state, cliHomeDir);
  // No harness permission_mode → the trust gate is inert, isolating the auth gate.

  await d.handleTrigger(makeEvent({ field_changed: 'a1' }));

  assert.equal(state.spawns.length, 0, 'no strand spawned with an expired, unrenewable OAuth session');
  assert.equal(countTool('pend_ticket'), 1, 'a durable CLI-credential blocker pends on the FIRST abort');
  assert.equal(countTool('add_comment'), 1, 'the abort posts a single actionable ticket comment');
  assert.equal(ticketState.pending_user_action, true);

  // Recovery: operator re-authenticates (fresh, far-future expiry) and unpends.
  await fsp.writeFile(
    join(cliHomeDir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'y', expiresAt: Date.now() + 3_600_000, refreshToken: 'r' } }),
  );
  ticketState.pending_user_action = false;
  await d.handleTrigger(makeEvent({ field_changed: 'recover' }));

  assert.equal(state.spawns.length, 1, 'recovery spawned exactly one strand once a live credential was in place');
});

test('an expired OAuth credential that STILL has a refresh token never blocks (the CLI self-renews)', async () => {
  const cliHomeDir = await makeCliHomeDir();
  await fsp.writeFile(
    join(cliHomeDir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'x', expiresAt: Date.now() - 60_000, refreshToken: 'still-here' } }),
  );
  const state = newState();
  const d = makeDispatcher(state, cliHomeDir);

  await d.handleTrigger(makeEvent({ field_changed: 'a1' }));

  assert.equal(state.spawns.length, 1, 'a present refresh_token means the CLI self-renews — not a durable blocker');
  assert.equal(countTool('pend_ticket'), 0);
});

// ── (3) control: the common default path is completely unaffected ──────────

test('control: an untrusted, credential-less cli-home under the DEFAULT harness never blocks — the gate is inert', async () => {
  const cliHomeDir = await makeCliHomeDir(); // untrusted, no credentials file, no harness_config at all
  const state = newState();
  const d = makeDispatcher(state, cliHomeDir);

  await d.handleTrigger(makeEvent({ field_changed: 'a1' }));

  assert.equal(state.spawns.length, 1, 'the common case (no board harness override) is unaffected by this gate');
  assert.equal(countTool('pend_ticket'), 0);
  assert.equal(countTool('add_comment'), 0);
});

// ── (4) ticket 152e3606: 티켓 워크스페이스 trust 시딩 — bypass에서만, fire-and-forget ──

test('ticket 152e3606: bypassPermissions 티켓 디스패치는 워크스페이스 trust를 백그라운드로 시딩한다', async () => {
  const cliHomeDir = await makeCliHomeDir(); // untrusted, harness_config 없음 → bypassPermissions
  const state = newState();
  const d = makeDispatcher(state, cliHomeDir);

  await d.handleTrigger(makeEvent({ field_changed: 'seed-a1' }));
  assert.equal(state.spawns.length, 1, 'bypass 모드는 trust 상태와 무관하게 즉시 스폰된다');

  // fire-and-forget이라 handleTrigger가 resolve된 시점엔 시딩이 아직 진행
  // 중일 수 있다 — 드레인해서 배경 쓰기가 끝난 뒤 파일 상태를 확인한다.
  await _drainTrustSeedLocksForTests();
  const raw = JSON.parse(await fsp.readFile(join(cliHomeDir, '.claude.json'), 'utf8'));
  assert.equal(
    raw.projects[CWD]?.hasTrustDialogAccepted,
    true,
    '지금은 bypass라 trust가 무관해도, 이 워크스페이스가 나중에 non-bypass harness로 재사용될 때를 위해 미리 trusted로 남겨둬야 한다',
  );
});

test('ticket 152e3606: non-bypass permission_mode에서는 워크스페이스 trust 시딩을 아예 시도하지 않는다', async () => {
  const cliHomeDir = await makeCliHomeDir(); // untrusted — .claude.json 자체가 아직 없음
  const state = newState();
  const d = makeDispatcher(state, cliHomeDir);
  const harness_config = { permission_mode: 'default' };

  await d.handleTrigger(makeEvent({ harness_config, field_changed: 'seed-b1' }));
  assert.equal(state.spawns.length, 0, '기존 계약대로 pend되어 스폰되지 않아야 한다');

  await _drainTrustSeedLocksForTests();
  const exists = await fsp
    .access(join(cliHomeDir, '.claude.json'))
    .then(() => true)
    .catch(() => false);
  assert.equal(
    exists,
    false,
    'non-bypass 게이트가 활성인 동안은 .claude.json 자체가 새로 생기면 안 된다 — 이 분기에서는 시딩을 호출 자체를 하지 않아야 한다(ticket 48aeab6e 계약 보존)',
  );
});

// ── (5) ticket 5851e435: Agent trust 가 CLI 권한의 기준 ──────────────────────
//
// 요구사항: "Pending 은 실제 사람 승인/secret/irreversible-risk gate 에만
// 생성하고, CLI 내부 permission/trust dialog 때문에 생성하지 않는다" +
// "Claude workspace trust preflight 가 trusted 에서는 Pending 을 만들지 않음".
// (1) 의 케이스와 **완전히 같은 조건**(빈 cli-home + non-bypass harness)에
// Agent trust=trusted 만 얹어, 그 하나로 Pending 이 사라지는지 확인한다.

test('ticket 5851e435: trusted Agent 는 non-bypass harness 에서도 Pending 없이 스폰된다', async () => {
  const cliHomeDir = await makeCliHomeDir(); // (1) 과 동일하게 .claude.json 없음
  const state = newState();
  const d = makeDispatcher(state, cliHomeDir, { strategy: 'single', permission_mode: 'trusted' });

  // (1) 을 Pending 으로 몰아넣었던 바로 그 harness 값.
  await d.handleTrigger(makeEvent({ harness_config: { permission_mode: 'default' }, field_changed: 'trusted-a1' }));

  assert.equal(state.spawns.length, 1, 'trusted Agent 는 harness 값과 무관하게 실제로 스폰돼야 한다');
  assert.equal(countTool('pend_ticket'), 0, 'CLI 내부 trust 대화상자 때문에 Pending 을 만들면 안 된다');
  assert.equal(countTool('add_comment'), 0, 'blocker 코멘트도 남지 않는다');
  assert.equal(ticketState.pending_user_action, false);

  // trusted 는 스킵 플래그로 대화상자를 우회하므로, 시딩 경로도 (4) 와 같이
  // 백그라운드로 돌아 이 폴더를 나중을 위해 trusted 로 남긴다.
  await _drainTrustSeedLocksForTests();
  const raw = JSON.parse(await fsp.readFile(join(cliHomeDir, '.claude.json'), 'utf8'));
  assert.equal(raw.projects[CWD]?.hasTrustDialogAccepted, true);
});

test('ticket 5851e435: trusted Agent 는 harness 가 요구한 모든 비-bypass 모드에서 Pending 을 만들지 않는다', async () => {
  for (const mode of ['default', 'acceptEdits', 'manual', 'plan', 'dontAsk', 'auto']) {
    mcpToolCalls.length = 0;
    addCommentContents.length = 0;
    ticketState.pending_user_action = false;
    const cliHomeDir = await makeCliHomeDir();
    const state = newState();
    const d = makeDispatcher(state, cliHomeDir, { strategy: 'single', permission_mode: 'trusted' });

    await d.handleTrigger(makeEvent({ harness_config: { permission_mode: mode }, field_changed: `t-${mode}` }));

    assert.equal(state.spawns.length, 1, `harness=${mode}: trusted Agent 가 스폰되지 않았다`);
    assert.equal(countTool('pend_ticket'), 0, `harness=${mode}: Pending 이 생성됐다`);
  }
});

test('ticket 5851e435: Agent trust 가 approve/strict 라도 harness 를 안 건드린 보드에서는 새 Pending 이 생기지 않는다', async () => {
  // legacy 백필(`{strategy:'single', permission_mode:'approve'}`)이 박힌
  // 에이전트가 harness 설정이 전혀 없는 보드에서 도는 조합. 폴더 trust 는
  // 도구 권한과 별개 축이므로, 등급이 내려갔다는 이유만으로 대화형 trust
  // 게이트가 새로 생기면 안 된다 — 그러면 이 티켓이 없애려는 실패 모드가
  // 그대로 재현된다.
  for (const trust of ['approve', 'strict']) {
    mcpToolCalls.length = 0;
    ticketState.pending_user_action = false;
    const cliHomeDir = await makeCliHomeDir();
    const state = newState();
    const d = makeDispatcher(state, cliHomeDir, { strategy: 'single', permission_mode: trust });

    await d.handleTrigger(makeEvent({ field_changed: `legacy-${trust}` }));

    assert.equal(state.spawns.length, 1, `trust=${trust}: harness 없는 보드에서 스폰이 막혔다`);
    assert.equal(countTool('pend_ticket'), 0, `trust=${trust}: Pending 이 생성됐다`);
  }
});

test('ticket 5851e435: 운영자가 harness 로 사람 trust 승인을 요구한 보드에서는 approve/strict 게이트가 그대로 유지된다', async () => {
  // (1) 이 고정한 ticket 48aeab6e 계약. Agent trust 가 trusted 가 아닌 이상
  // harness 의 명시적 요구는 계속 살아 있어야 한다.
  const cliHomeDir = await makeCliHomeDir();
  const state = newState();
  const d = makeDispatcher(state, cliHomeDir, { strategy: 'single', permission_mode: 'approve' });

  await d.handleTrigger(makeEvent({ harness_config: { permission_mode: 'plan' }, field_changed: 'gate-kept' }));

  assert.equal(state.spawns.length, 0, 'harness 가 명시적으로 비-bypass 를 요구했고 trust 도 trusted 가 아니다');
  assert.equal(countTool('pend_ticket'), 1, '기존 안전 경계가 유지돼야 한다');
});
