// Integration test — durable provisioning-failure block + single-strand (ticket 52eedadf).
//
// Rewritten for the review (blockers #1/#2). The previous version drove a
// tool-NAME-only /mcp mock and a trivial spawn() that could never twin, so it
// proved neither the durable-FIRST-abort pend nor the (ticket,role) single-flight
// under a transition race. This version stitches the REAL manager pieces across
// the server↔manager boundary:
//   • the /mcp mock is STATEFUL — pend_ticket flips pending_user_action=true and
//     unpend_ticket clears it, so the test asserts the real pend transition, not
//     just "a tool named pend_ticket was invoked". (The SERVER half of the
//     boundary — getAllocatedTickets dropping BOTH normal and forced triggers for
//     a pending ticket — is proven against the real gate in
//     apps/server/test/provisioning-pending-allocation-gate.test.mjs.)
//   • the subagentManager fake runs the PRODUCTION findDuplicateSpawn over a
//     synchronous dedup-scan → identity reservation, exactly like
//     SubagentManager.spawn(), so two concurrent triggers for the same
//     (ticket,role,agent) collapse to one spawn — the real inflight single-flight,
//     not a stub that can never twin.
//
// What it proves (maps to the review asks):
//   (1) a DURABLE provisioning failure (not_a_git_repo) pends on the FIRST abort
//       — no repeated provisioning/spawn — and after explicit recovery exactly
//       ONE strand spawns;
//   (b) concurrent triggers racing the pend transition pend exactly once and
//       spawn zero twins;
//   (c) concurrent recovery triggers (distinct trigger ids, same ticket/role/
//       agent) spawn EXACTLY ONE strand via the real single-flight;
//   (4) a TRANSIENT blocker (path_conflict) does NOT pend on the first abort — it
//       keeps the cooldown self-heal and only pends after the threshold.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { EventDispatcher } from '../dist/lib/event-dispatcher.js';
import { findDuplicateSpawn } from '../dist/lib/subagent-manager.js';
import { composeTriggerPrompt } from '../dist/lib/prompts.js';

const AGENT = 'agent-rolf';
const TICKET = 'ticket-prov';

// A fully-bootstrapped managed-agent context so #resolveAgentContext returns a
// real cwd/apiKey (otherwise #applyWorktreeCwd early-returns ok:true and the
// provisioning path is never exercised).
function makeCtx() {
  return {
    agent_id: AGENT,
    name: 'Rolf',
    cli: 'claude',
    working_dir: '/ws',
    mcp_config_path: '/cfg/mcp.json',
    api_key: 'k',
    cli_home_dir: '/cli-home/rolf',
    extra_env: {},
    credential_provider: null,
    model: null,
  };
}

let originalFetch;
let mcpToolCalls; // names of tools/call invoked over /mcp (add_comment, pend_ticket, …)
let ticketState;  // the (mocked) server-side ticket row the pend/unpend transition mutates

beforeEach(() => {
  originalFetch = globalThis.fetch;
  mcpToolCalls = [];
  ticketState = { pending_user_action: false };
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
        // Stateful boundary: the manager's pend_ticket call actually flips the
        // server ticket's pending flag (and unpend clears it), so the test can
        // assert the real transition rather than just the tool name.
        if (name === 'pend_ticket') ticketState.pending_user_action = true;
        if (name === 'unpend_ticket') ticketState.pending_user_action = false;
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '{}' }] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('', { status: 202 }); // notifications/initialized, etc.
    }
    // REST GETs: repository git-credential (→ no token) and ticket context (→ {}).
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Faithful subagentManager: mirrors SubagentManager.spawn()'s SYNCHRONOUS
// dedup-scan (production findDuplicateSpawn) → identity reservation, so a second
// near-simultaneous spawn for the same (ticket,role,agent) — even with a
// DIFFERENT trigger id — collapses to duplicate_trigger before it can twin. The
// reservation stays in `records` (modelling a live strand) so a later trigger
// while the strand is alive also dedups.
function makeSubagentManager(state) {
  const records = new Map(); // reservationId → SpawnIdentityRecord
  let resCounter = 0;
  return {
    canSpawn: () => true,
    async spawn(spec) {
      const dup = findDuplicateSpawn(records.values(), spec);
      if (dup) {
        state.dedups.push({ trigger: spec.triggerId, reason: dup });
        return { spawned: false, reason: dup };
      }
      const id = --resCounter; // reserve SYNCHRONOUSLY (no await before this)
      records.set(id, {
        kind: spec.kind,
        trigger_id: spec.triggerId || null,
        chat_request_id: spec.chatRequestId || null,
        ticket_id: spec.ticketId || null,
        role: spec.role || null,
        agent_id: spec.agentId || null,
      });
      state.spawns.push(spec);
      return { spawned: true, pid: 4200 - id };
    },
  };
}

function makeDispatcher(state) {
  const worktreeManager = {
    enabled: true,
    async resolveCwd() {
      state.resolveCalls += 1;
      if (state.broken) return { isWorktree: false, reason: state.reason, detail: state.detail };
      return {
        isWorktree: true,
        cwd: '/ws/.awb/wt/ok',
        mode: 'per_ticket',
        reused: false,
        repositoryContext: state.repositoryContext,
      };
    },
    async verifyCheckout() { return { ok: true }; },
    async verifyPushReadiness() { return { ok: true }; },
    async removeTicketWorktrees() { return 0; },
    async removeTicketRunWorkspace() { return false; },
  };
  const managedAgentContexts = {
    get: (id) => (id === AGENT ? makeCtx() : null),
    has: (id) => id === AGENT,
    list: () => [{ working_dir: '/ws' }],
  };
  // No ticketSessionManager → the dispatcher falls to the one-shot subagent path,
  // whose spawn() (our faithful single-flight fake) we count.
  return new EventDispatcher(
    { url: 'http://127.0.0.1:0', apiKey: 'test-key', delegation: { enabled: true } },
    {
      worktreeManager,
      subagentManager: makeSubagentManager(state),
      managedAgentContexts,
      prompts: { composeTriggerPrompt },
    },
  );
}

function newState(overrides = {}) {
  return { resolveCalls: 0, spawns: [], dedups: [], broken: true, reason: 'not_a_git_repo', ...overrides };
}

function makeEvent(overrides = {}) {
  return JSON.stringify({
    event_type: 'agent_trigger',
    ticket_id: TICKET,
    action: 'assignee',
    actor_name: AGENT,
    field_changed: 'trig',
    trigger_source: 'column_move', // non-supervisor by default (always runs preflight)
    base_repo: { id: 'repo-1', url: 'https://github.com/acme/app.git', default_branch: 'main' },
    base_branch: 'main',
    ...overrides,
  });
}

const countTool = (name) => mcpToolCalls.filter((n) => n === name).length;

test('실제 dispatch는 auth failure를 fallback하지 않고 즉시 중단한다', async () => {
  const state = newState({ reason: 'repository_auth_failed', detail: 'fatal: 인증 실패' });
  const d = makeDispatcher(state);

  await d.handleTrigger(makeEvent({ field_changed: 'auth-failure' }));

  assert.equal(state.spawns.length, 0, '인증 실패에서는 담당 에이전트를 시작하지 않는다');
  assert.equal(countTool('pend_ticket'), 0, '인증 실패 진단 자체는 credential 원문 요청이나 자동 변경을 유발하지 않는다');
  assert.equal(countTool('add_comment'), 1, '원인별 진단을 티켓에 기록한다');
});

test('안전한 fallback 성공은 실제 dispatch를 계속하고 복구·중복 방지 prompt를 전달한다', async () => {
  const state = newState({ reason: 'repository_fetch_failed', detail: 'exit 128: 원격 일시 오류' });
  const d = makeDispatcher(state);

  await d.handleTrigger(makeEvent({ field_changed: 'safe-fallback' }));

  assert.equal(state.spawns.length, 1, '안전한 로컬 복구 가능 실패는 담당 에이전트에게 이어진다');
  const prompt = state.spawns[0].taskText;
  assert.match(prompt, /AWB 저장소 준비 fallback/);
  assert.match(prompt, /repository_fetch_failed/);
  assert.match(prompt, /원래 의도/);
  assert.match(prompt, /기대 결과/);
  assert.match(prompt, /재현 정보: exit 128: 원격 일시 오류/);
  assert.match(prompt, /허용 범위/);
  assert.match(prompt, /기존 개선 티켓을 먼저 검색/);
  assert.match(prompt, /동일 항목이 없을 때 최대 1건만 등록/);
  assert.match(prompt, /일회성 오류나 중복 항목은 등록하지/);
  assert.doesNotMatch(prompt, /토큰 원문을 (?:입력|요청)/);
});

test('fallback 비허용 실패는 prompt 없이 dispatch를 중단한다', async () => {
  const state = newState({ reason: 'base_branch_unavailable', detail: 'origin/release 없음' });
  const d = makeDispatcher(state);

  await d.handleTrigger(makeEvent({ field_changed: 'unsafe-fallback' }));

  assert.equal(state.spawns.length, 0, '안전하지 않은 복구 실패에는 strand가 생성되지 않는다');
  assert.equal(countTool('pend_ticket'), 0);
  assert.equal(countTool('add_comment'), 1);
});

test('정상 provisioning dispatch는 확정 repository context를 실제 prompt로 전달한다', async () => {
  const state = newState({
    broken: false,
    repositoryContext: {
      resourceId: 'repo-1', cwd: '/ws/.awb/wt/ok', baseBranch: 'release',
      baseSha: 'abc123', workingBranch: 'ticket/ticket-prov-work', dirty: true,
      ahead: 3, behind: 2, resumed: true,
    },
  });
  const d = makeDispatcher(state);

  await d.handleTrigger(makeEvent({ base_branch: 'release', field_changed: 'context' }));

  assert.equal(state.spawns.length, 1);
  assert.match(state.spawns[0].taskText, /Repository Resource ID: repo-1/);
  assert.match(state.spawns[0].taskText, /base branch \/ SHA: release \/ abc123/);
  assert.match(state.spawns[0].taskText, /working branch: ticket\/ticket-prov-work/);
  assert.match(state.spawns[0].taskText, /dirty: true/);
  assert.match(state.spawns[0].taskText, /ahead \/ behind: 3 \/ 2/);
});

// ── (1) durable → first-abort pend, no repeated spawn, recovery → one strand ──

test('durable failure pends on the FIRST abort, spawns nothing, and recovers to exactly one strand', async () => {
  const state = newState(); // broken, not_a_git_repo (durable)
  const d = makeDispatcher(state);

  // ONE durable failure → pend immediately (review blocker #1: no waiting out the
  // 3-probe threshold). No strand spawned; the abort comment posts once.
  await d.handleTrigger(makeEvent({ field_changed: 'a1' }));
  assert.equal(state.spawns.length, 0, 'no strand spawned while provisioning is broken');
  assert.equal(countTool('pend_ticket'), 1, 'a durable blocker pends on the FIRST abort');
  assert.equal(countTool('add_comment'), 1, 'the abort posts a single ticket comment');
  assert.equal(ticketState.pending_user_action, true, 'the pend transition actually set pending_user_action');

  // While pended, a supervisor re-trigger is dropped BEFORE re-provisioning — the
  // manager-side damper (belt to the server-side getAllocatedTickets drop that the
  // server test exercises against the real gate). No new provisioning, no spawn,
  // no duplicate pend.
  const resolveBefore = state.resolveCalls;
  await d.handleTrigger(makeEvent({ trigger_source: 'supervisor', field_changed: 'sup1' }));
  assert.equal(state.resolveCalls, resolveBefore, 'supervisor re-trigger suppressed before re-provisioning');
  assert.equal(state.spawns.length, 0, 'a suppressed supervisor trigger spawns nothing');
  assert.equal(countTool('pend_ticket'), 1, 'no duplicate pend while already pended');

  // Explicit recovery: operator fixes the env and unpends. The resumed dispatch is
  // a non-supervisor (state-changed) trigger that always passes the backoff.
  state.broken = false;
  ticketState.pending_user_action = false; // operator unpend
  await d.handleTrigger(makeEvent({ field_changed: 'recover' }));

  assert.equal(state.spawns.length, 1, 'recovery spawned exactly one strand');
  assert.equal(state.spawns[0].ticketId, TICKET);
  assert.equal(state.spawns[0].role, 'assignee');
});

// ── (b) concurrent triggers racing the pend transition → one pend, zero twins ──

test('concurrent durable triggers racing the pend transition pend exactly once and spawn no twin', async () => {
  const state = newState();
  const d = makeDispatcher(state);

  // Two triggers arrive together (distinct trigger ids) as the block becomes
  // durable. note() is synchronous, so exactly ONE crosses the pend threshold;
  // both abort at preflight, so neither spawns.
  await Promise.all([
    d.handleTrigger(makeEvent({ field_changed: 'race-a' })),
    d.handleTrigger(makeEvent({ field_changed: 'race-b' })),
  ]);

  assert.equal(state.spawns.length, 0, 'no strand spawned during the pend-transition race');
  assert.equal(countTool('pend_ticket'), 1, 'exactly one pend across the concurrent race (no duplicate)');
  assert.equal(ticketState.pending_user_action, true, 'the ticket ended up pended');
});

// ── (c) concurrent recovery triggers → exactly one strand (real single-flight) ─

test('concurrent recovery triggers spawn EXACTLY ONE strand via the real (ticket,role,agent) single-flight', async () => {
  const state = newState();
  const d = makeDispatcher(state);

  // Drive to a durable pend first.
  await d.handleTrigger(makeEvent({ field_changed: 'a1' }));
  assert.equal(countTool('pend_ticket'), 1);

  // Recover: env fixed + operator unpend.
  state.broken = false;
  ticketState.pending_user_action = false;

  // TWO recovery triggers arrive together with DIFFERENT trigger ids but the SAME
  // (ticket, role, agent). Only rule-3 single-flight (NOT exact-trigger-id dedup)
  // can collapse them — this is the transition-race twin the ticket must prevent.
  await Promise.all([
    d.handleTrigger(makeEvent({ field_changed: 'recover-a' })),
    d.handleTrigger(makeEvent({ field_changed: 'recover-b' })),
  ]);

  assert.equal(state.spawns.length, 1, 'concurrent recovery spawned exactly one strand (정확히 한 strand)');
  // ticket 3d180f85: the provision-spanning single-flight gate now collapses the
  // concurrent-recovery twin ONE LAYER EARLIER than findDuplicateSpawn — it is
  // suppressed at the gate (before it re-provisions or reaches spawn), so it never
  // reaches the spawn-dedup here. findDuplicateSpawn stays the defense-in-depth
  // backstop (exercised directly in dispatch-inflight-guard.test.mjs and its own
  // unit tests). The core invariant is unchanged and now enforced sooner: EXACTLY
  // one strand, with the twin collapsed by the authoritative single-flight.
  assert.equal(state.dedups.length, 0, 'twin suppressed at the gate, before the spawn-dedup layer runs');
  assert.deepEqual(
    d.dispatchSuppressionCounts(),
    { inflight_dispatch: 1 },
    'the recovery twin was collapsed by the provision-spanning single-flight gate',
  );
});

// ── (4) transient blocker keeps the cooldown self-heal (contrast to durable) ───

test('repository unavailable은 안전 fallback과 분리되어 반복 실패 후에만 보류된다', async () => {
  const state = newState({ reason: 'repository_unavailable' });
  const d = makeDispatcher(state);

  // First abort: no pend (unlike a durable blocker) — a sibling ticket might free
  // the path, so the cooldown gets a self-heal window first.
  await d.handleTrigger(makeEvent({ field_changed: 't1' }));
  assert.equal(state.spawns.length, 0, 'repository unavailable: no spawn');
  assert.equal(countTool('pend_ticket'), 0, 'repository unavailable: 첫 실패에는 보류하지 않는다');
  assert.equal(ticketState.pending_user_action, false, 'repository unavailable: ticket not pended yet');

  // Two more state-changed (non-supervisor, so never cooldown-suppressed) aborts
  // reach DEFAULT_PEND_AFTER_ABORTS (3). Only then does even a transient block
  // pend. (In the field a transient is mostly re-probed by cooldown-gated
  // supervisor triggers; driving state-changed ones here reaches the threshold
  // deterministically without a fake clock — the pend mechanism is identical.)
  await d.handleTrigger(makeEvent({ field_changed: 't2' }));
  assert.equal(countTool('pend_ticket'), 0, '두 번째 실패까지 보류하지 않는다');
  await d.handleTrigger(makeEvent({ field_changed: 't3' }));
  assert.equal(countTool('pend_ticket'), 1, '지속되는 repository unavailable은 임계값에서 보류한다');
  assert.equal(state.spawns.length, 0, '전체 retry 구간에 strand가 생성되지 않는다');
});

// ── re-arm: a recovered ticket-role backs off afresh on a later break ──────────

test('a recovered ticket-role re-arms: a later durable break pends afresh (no stale carry)', async () => {
  const state = newState();
  const d = makeDispatcher(state);

  await d.handleTrigger(makeEvent({ field_changed: 'a1' }));
  assert.equal(countTool('pend_ticket'), 1, 'durable block pended');

  // Recover (green preflight clears the suppressor episode).
  state.broken = false;
  ticketState.pending_user_action = false;
  await d.handleTrigger(makeEvent({ field_changed: 'recover' }));
  assert.equal(state.spawns.length, 1, 'recovered with one strand');
  // ticket f0d1da19: production holds handleTrigger's own provision-span
  // reservation via SubagentSpawnArgs.onExit until the spawned one-shot ACTUALLY
  // exits, not the instant spawn() resolves a pid. The recovered strand finishing
  // is what the next step's "fresh break" assumes, so fire its onExit the same
  // way dispatch-inflight-guard.test.mjs does — otherwise the still-"held" seat
  // suppresses the next trigger below as a twin before it ever reaches preflight.
  state.spawns[state.spawns.length - 1].onExit?.();

  // A brand-new durable break after recovery pends afresh (episode re-armed) —
  // exactly once, not a stale double-count.
  const pendsBefore = countTool('pend_ticket');
  state.broken = true;
  await d.handleTrigger(makeEvent({ field_changed: 'c1' }));
  assert.equal(countTool('pend_ticket'), pendsBefore + 1, 'the fresh durable break pends again on its first abort');
  assert.equal(state.spawns.length, 1, 'the fresh break spawns nothing new');
});
