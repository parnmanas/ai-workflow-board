// Burst-dedup tests for TicketSessionManager and ChatSessionManager.
//
// These exercise the dispatch-side guarantees of ticket
// 52e581ce-629a-4643-86ee-fcd37e038c8e:
//
//   (a) Two near-simultaneous triggers / messages on the same session key
//       must produce exactly one spawn — the second one collapses to the
//       in-flight reservation guard.
//   (b) A second event arriving AFTER the first spawn has landed in
//       `_sessions` must reuse that pid and send a follow-up turn instead
//       of spawning a new child.
//   (c) A stale `_sessions` entry whose pid is no longer alive at the OS
//       level must be purged by `_getLiveSession` so it can't either be
//       wrongly reused (turn into dead stdin) or wrongly block a fresh
//       spawn for the same key.
//
// We override `_spawnSession` and `_sendFollowUp` on subclasses so the test
// never actually forks a CLI child — those are the integration points the
// dedup logic gates on, and the rest of the spawn machinery is irrelevant
// here. Counter + log capture is enough to assert the contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Import compiled JS — agent-manager builds via `npm run build` and we run
// `node --test` against the dist tree, mirroring apps/server/test style.
import { TicketSessionManager as RealTicketMgr } from '../dist/lib/ticket-session-manager.js';
import { ChatSessionManager as RealChatMgr } from '../dist/lib/chat-session-manager.js';

function makeConfig() {
  return {
    url: 'http://127.0.0.1:0',
    apiKey: 'test-key',
    delegation: {
      enabled: true,
      maxConcurrent: 10,
      idleMinutes: 999,
      maxTurnsPerSession: 999,
    },
  };
}

function makeFakeSession(sessionKey, keyField, pid) {
  const child = {
    pid,
    stdin: { write: () => true, end: () => {} },
    stdout: null,
    stderr: null,
    once: () => {},
  };
  return {
    [keyField]: sessionKey,
    pid,
    cli_type: 'test',
    adapter: {
      cliType: 'test',
      formatTurn: (s) => String(s),
      parseStdoutLine: () => ({ stage: null, isResult: false, raw: null }),
      has: () => false,
    },
    child,
    configPath: null,
    configPathIsTemp: false,
    pidPath: null,
    turnCount: 0,
    startedAt: Date.now(),
    lastTouchedAt: Date.now(),
    idleTimer: null,
    unrespondedTurnCount: 0,
    unrespondedSince: null,
    unhealthyKilled: false,
    tap: null,
  };
}

class FakeTicketMgr extends RealTicketMgr {
  constructor(cfg, spawnDelayMs = 30) {
    super(cfg);
    this.spawnCount = 0;
    this.spawnDelayMs = spawnDelayMs;
    this.followUps = [];
    this.firstTurns = [];
    // Track which synthetic pids we've "minted" so the real-pid liveness
    // probe can opt out for our fake children only.
    this.__alivePids = new Set();
  }
  // Pretend our fake pids are alive so `_getLiveSession` doesn't purge them
  // on the second dispatch. Real-pid lookups (process.pid, sentinel-dead)
  // still go through the normal OS probe so the stale-session test stays
  // honest.
  _isPidAlive(pid) {
    if (this.__alivePids.has(pid)) return true;
    return super._isPidAlive(pid);
  }
  async _spawnSession(sessionKey, _rolePrompt, firstTurnText, _opts) {
    this.spawnCount++;
    const pid = 90000 + this.spawnCount;
    this.__alivePids.add(pid);
    this.firstTurns.push({ sessionKey, firstTurnText, pid });
    await new Promise((r) => setTimeout(r, this.spawnDelayMs));
    const sess = makeFakeSession(sessionKey, 'sessionKey', pid);
    sess.turnCount = 1;
    this._sessions.set(sessionKey, sess);
    return sess;
  }
  _sendFollowUp(sess, turnText, _opts) {
    this.followUps.push({ pid: sess.pid, turnText });
    sess.turnCount++;
    sess.lastTouchedAt = Date.now();
  }
}

class FakeChatMgr extends RealChatMgr {
  constructor(cfg, spawnDelayMs = 30) {
    super(cfg);
    this.spawnCount = 0;
    this.spawnDelayMs = spawnDelayMs;
    this.followUps = [];
    this.firstTurns = [];
    this.__alivePids = new Set();
  }
  _isPidAlive(pid) {
    if (this.__alivePids.has(pid)) return true;
    return super._isPidAlive(pid);
  }
  async _spawnSession(sessionKey, _rolePrompt, firstTurnText, _opts) {
    this.spawnCount++;
    const pid = 80000 + this.spawnCount;
    this.__alivePids.add(pid);
    this.firstTurns.push({ sessionKey, firstTurnText, pid });
    await new Promise((r) => setTimeout(r, this.spawnDelayMs));
    const sess = makeFakeSession(sessionKey, 'sessionKey', pid);
    sess.turnCount = 1;
    this._sessions.set(sessionKey, sess);
    return sess;
  }
  _sendFollowUp(sess, turnText, _opts) {
    this.followUps.push({ pid: sess.pid, turnText });
    sess.turnCount++;
    sess.lastTouchedAt = Date.now();
  }
}

// ─── Ticket-session dedup ───────────────────────────────────────────────

test('ticket-session: burst of two triggers on same (ticket, role) produces ONE spawn', async () => {
  const mgr = new FakeTicketMgr(makeConfig(), 40);
  const base = {
    ticketId: 'ticket-burst',
    role: 'assignee',
    agentId: 'agent-1',
    rolePrompt: '',
    ticketPrompt: '',
    columnPrompt: null,
    ticket: { title: 'Burst' },
    forceRespawn: false,
    maxConcurrentTicketsPerAgent: 5,
  };
  // Different triggerIds so the per-trigger dedup table doesn't reject;
  // the in-flight guard is what we want to exercise here.
  const p1 = mgr.dispatchTrigger({ ...base, triggerId: 'trig-A' });
  const p2 = mgr.dispatchTrigger({ ...base, triggerId: 'trig-B' });
  const [r1, r2] = await Promise.all([p1, p2]);

  assert.equal(mgr.spawnCount, 1, 'exactly one spawn across the burst');
  assert.equal(r1.dispatched, true);
  assert.equal(r1.firstTurn, true);
  assert.equal(r2.dispatched, false);
  assert.equal(r2.reason, 'inflight_spawn');
});

test('ticket-session: second trigger AFTER first spawn lands collapses to follow-up turn on same pid', async () => {
  const mgr = new FakeTicketMgr(makeConfig(), 5);
  const base = {
    ticketId: 'ticket-follow',
    role: 'assignee',
    agentId: 'agent-1',
    rolePrompt: '',
    ticketPrompt: '',
    columnPrompt: null,
    ticket: { title: 'Follow' },
    forceRespawn: false,
    maxConcurrentTicketsPerAgent: 5,
  };
  const r1 = await mgr.dispatchTrigger({ ...base, triggerId: 't1' });
  const r2 = await mgr.dispatchTrigger({ ...base, triggerId: 't2' });

  assert.equal(mgr.spawnCount, 1, 'no second spawn');
  assert.equal(r1.dispatched, true);
  assert.equal(r2.dispatched, true);
  assert.equal(r2.pid, r1.pid, 'second dispatch reuses the same pid');
  assert.equal(r2.firstTurn, undefined, 'second dispatch is not a first-turn');
  assert.equal(mgr.followUps.length, 1, 'exactly one follow-up turn was written');
});

test('ticket-session: same (ticket, role) but DIFFERENT holder agents get SEPARATE sessions (다중담당자 T7)', async () => {
  // 한 manager 가 같은 role 의 공동 홀더 agent 둘을 소유할 때(T2 팬아웃), 두 번째
  // 홀더의 트리거가 첫 홀더 세션의 follow-up 으로 접히면 그 홀더는 자기 identity
  // 로 record_agreement 를 못 해 합의가 데드락된다. 키에 agent 차원이 들어가
  // 각자 스폰되어야 한다.
  const mgr = new FakeTicketMgr(makeConfig(), 5);
  const base = {
    ticketId: 'ticket-mh',
    role: 'assignee',
    rolePrompt: '',
    ticketPrompt: '',
    columnPrompt: null,
    ticket: { title: 'MultiHolder' },
    forceRespawn: false,
    maxConcurrentTicketsPerAgent: 5,
  };
  const rA = await mgr.dispatchTrigger({ ...base, triggerId: 'trig-A', agentId: 'agent-A' });
  const rB = await mgr.dispatchTrigger({ ...base, triggerId: 'trig-B', agentId: 'agent-B' });

  assert.equal(rA.dispatched, true);
  assert.equal(rB.dispatched, true);
  assert.equal(mgr.spawnCount, 2, 'each holder agent gets its own session');
  assert.notEqual(rB.pid, rA.pid, 'holder B must not fold into holder A session');
  assert.equal(rB.firstTurn, true, 'holder B starts a fresh first turn');

  // 같은 홀더의 재트리거는 종전대로 follow-up 으로 접힌다(단일-플라이트 유지).
  const rA2 = await mgr.dispatchTrigger({ ...base, triggerId: 'trig-A2', agentId: 'agent-A' });
  assert.equal(rA2.dispatched, true);
  assert.equal(rA2.pid, rA.pid, 'same holder reuses its own session');
  assert.equal(mgr.spawnCount, 2, 'no third spawn for a same-holder re-trigger');

  // 보드 업데이트 브로드캐스트는 두 홀더 세션 모두에 전달된다.
  const before = mgr.followUps.length;
  const forwarded = mgr.forwardBoardUpdate('ticket-mh', { entity_type: 'ticket', action: 'updated' });
  assert.equal(forwarded, true);
  const pids = mgr.followUps.slice(before).map((f) => f.pid).sort();
  assert.deepEqual(pids, [rA.pid, rB.pid].sort(), 'board update reaches BOTH holder sessions');
});

test('ticket-session: force-respawn (ticket_done_review) terminates a drifted-key twin sibling, spares a distinct co-holder (ticket 7e7e23bf)', async () => {
  // The reviewer-twin gap: a lingering same-(ticket, role) strand survives under
  // a DRIFTED sessionKey (the unknown-agent `_` bucket) while the Done
  // retrospective force-spawns a FRESH ticket_done_review session. The server's
  // in-flight gate misses this because set_current_task lags, and
  // RespawnStormDetector only notices ~5 min later. #terminateTwinSiblings closes
  // it in real time: the force-respawn dispatch must SIGTERM the drifted sibling
  // yet leave a DISTINCT co-holder (다중담당자) untouched.
  const mgr = new FakeTicketMgr(makeConfig(), 5);

  // High sentinel pids that map to no live process, so the SIGTERM in
  // #terminateTwinSiblings throws ESRCH (caught) instead of hitting anything.
  const DRIFT_PID = 2147483641;
  const CO_PID = 2147483642;

  const drift = makeFakeSession('ticket-twin:reviewer:_', 'sessionKey', DRIFT_PID);
  drift.ticketId = 'ticket-twin';
  drift.role = 'reviewer';
  drift.agentId = ''; // unknown `_` bucket — same holder, drifted key
  mgr._sessions.set('ticket-twin:reviewer:_', drift);

  const co = makeFakeSession('ticket-twin:reviewer:agent-OTHER', 'sessionKey', CO_PID);
  co.ticketId = 'ticket-twin';
  co.role = 'reviewer';
  co.agentId = 'agent-OTHER'; // a DISTINCT co-holder — must be preserved
  mgr._sessions.set('ticket-twin:reviewer:agent-OTHER', co);

  const r = await mgr.dispatchTrigger({
    ticketId: 'ticket-twin',
    role: 'reviewer',
    triggerId: 'trig-done-review',
    triggerSource: 'ticket_done_review',
    agentId: 'agent-R',
    rolePrompt: '',
    ticketPrompt: '',
    columnPrompt: null,
    ticket: { title: 'T' },
    forceRespawn: false,
    maxConcurrentTicketsPerAgent: 5,
  });

  assert.equal(r.dispatched, true, 'retrospective session spawned');
  assert.equal(r.firstTurn, true, 'fresh trigger-source session, not a reuse');

  // Drifted twin sibling collapsed: flagged (so its exit hook skips the
  // silent-exit fallback) and removed from the session map.
  assert.equal(drift._twinTerminated, true, 'drifted twin flagged terminated');
  assert.equal(
    mgr._sessions.has('ticket-twin:reviewer:_'),
    false,
    'drifted twin removed from _sessions',
  );

  // Distinct co-holder untouched (다중담당자 fan-out preserved).
  assert.equal(co._twinTerminated, undefined, 'distinct co-holder NOT terminated');
  assert.equal(
    mgr._sessions.has('ticket-twin:reviewer:agent-OTHER'),
    true,
    'co-holder session preserved',
  );
});

test('ticket-session: stale session record (dead pid) is purged by _getLiveSession', async () => {
  const mgr = new FakeTicketMgr(makeConfig(), 5);
  const sessionKey = 'ticket-stale:assignee:agent-1';
  // A pid this high (just below INT32_MAX) is guaranteed not to map to a
  // live process — Linux pid_max defaults to 2^15 or 2^22, and macOS caps
  // even lower. process.kill(pid, 0) returns ESRCH.
  const DEAD_PID = 2147483640;
  const stale = makeFakeSession(sessionKey, 'sessionKey', DEAD_PID);
  stale.ticketId = 'ticket-stale';
  stale.role = 'assignee';
  stale.agentId = 'agent-1';
  mgr._sessions.set(sessionKey, stale);

  const live = mgr._getLiveSession(sessionKey);
  assert.equal(live, undefined, '_getLiveSession returns undefined for dead pid');
  assert.equal(mgr._sessions.has(sessionKey), false, 'stale record purged from map');

  // A fresh dispatch on the same key now succeeds with a real spawn.
  const r = await mgr.dispatchTrigger({
    ticketId: 'ticket-stale',
    role: 'assignee',
    triggerId: 'trig-fresh',
    agentId: 'agent-1',
    rolePrompt: '',
    ticketPrompt: '',
    columnPrompt: null,
    ticket: { title: 'S' },
    forceRespawn: false,
    maxConcurrentTicketsPerAgent: 5,
  });
  assert.equal(r.dispatched, true);
  assert.equal(r.firstTurn, true);
  assert.equal(mgr.spawnCount, 1);
});

test('ticket-session: _isPidAlive returns true for self pid, false for sentinel-dead pid', () => {
  const mgr = new FakeTicketMgr(makeConfig(), 5);
  assert.equal(mgr._isPidAlive(process.pid), true, 'self pid is alive');
  assert.equal(mgr._isPidAlive(2147483640), false, 'sentinel-dead pid is not alive');
  assert.equal(mgr._isPidAlive(0), false, 'pid=0 treated as not-alive');
  assert.equal(mgr._isPidAlive(-1), false, 'negative pid treated as not-alive');
});

// ─── Scope ①: unconditional in-flight guard (ticket a5ab95ea) ────────────
// Acceptance (b): "field_changed 빈 이벤트" — a trigger with an empty
// field_changed (→ triggerId='') AND an empty actor_name (→ agentId='') used
// to skip the in-flight guard entirely (it was gated on spec.agentId) and
// twin-spawn. The guard is now keyed on the sessionKey reservation regardless
// of agentId.

test('ticket-session: empty agentId + empty triggerId burst still produces ONE spawn', async () => {
  const mgr = new FakeTicketMgr(makeConfig(), 40);
  const base = {
    ticketId: 'ticket-noagent',
    role: 'assignee',
    agentId: '', // empty — the leak case
    triggerId: '', // empty field_changed → no per-trigger dedup
    rolePrompt: '',
    ticketPrompt: '',
    columnPrompt: null,
    ticket: { title: 'NoAgent' },
    forceRespawn: false,
    maxConcurrentTicketsPerAgent: 5,
  };
  const [r1, r2] = await Promise.all([
    mgr.dispatchTrigger({ ...base }),
    mgr.dispatchTrigger({ ...base }),
  ]);
  assert.equal(mgr.spawnCount, 1, 'exactly one spawn despite empty agentId+triggerId');
  // Whichever won the race, exactly one is a first-turn spawn and the other
  // collapses to the in-flight guard.
  const dispatched = [r1, r2].filter((r) => r.dispatched && r.firstTurn);
  const dropped = [r1, r2].filter((r) => !r.dispatched && r.reason === 'inflight_spawn');
  assert.equal(dispatched.length, 1, 'one first-turn spawn');
  assert.equal(dropped.length, 1, 'one inflight_spawn drop');
});

// ─── Scope ②: error / stuck (unhealthy) session is never reused ──────────
// Acceptance (c): an unhealthy-killed session must not be reused — the next
// trigger fresh-spawns. #killUnhealthy normally deletes the record; this
// asserts the belt-and-suspenders guard in _getLiveSession that refuses to
// reuse a record still flagged unhealthyKilled even while its pid lingers in
// the SIGTERM grace window.

test('ticket-session: unhealthyKilled session is not reused — _getLiveSession purges it', () => {
  const mgr = new FakeTicketMgr(makeConfig(), 5);
  const sessionKey = 'ticket-stuck:assignee:agent-1';
  const ALIVE_PID = 90555;
  mgr.__alivePids.add(ALIVE_PID); // pid is "alive" at the OS level…
  const stuck = makeFakeSession(sessionKey, 'sessionKey', ALIVE_PID);
  stuck.ticketId = 'ticket-stuck';
  stuck.role = 'assignee';
  stuck.agentId = 'agent-1';
  stuck.unhealthyKilled = true; // …but flagged unhealthy / mid-teardown
  mgr._sessions.set(sessionKey, stuck);

  const live = mgr._getLiveSession(sessionKey);
  assert.equal(live, undefined, 'unhealthy session is treated as not-live');
  assert.equal(mgr._sessions.has(sessionKey), false, 'unhealthy record purged from map');
});

test('ticket-session: next trigger after an unhealthy session fresh-spawns (no reuse)', async () => {
  const mgr = new FakeTicketMgr(makeConfig(), 5);
  // 3-세그먼트 키(ticketId:role:agentId) — dispatchTrigger 가 실제로 계산하는
  // 키와 일치해야 이 테스트가 공허 통과하지 않는다(구 2-세그먼트 리터럴은 아래
  // dispatch 가 다른 키를 보므로 stuck 레코드가 아예 조회되지 않았다).
  const sessionKey = 'ticket-stuck2:assignee:agent-1';
  const ALIVE_PID = 90777;
  mgr.__alivePids.add(ALIVE_PID);
  const stuck = makeFakeSession(sessionKey, 'sessionKey', ALIVE_PID);
  stuck.ticketId = 'ticket-stuck2';
  stuck.role = 'assignee';
  stuck.agentId = 'agent-1';
  stuck.unhealthyKilled = true;
  mgr._sessions.set(sessionKey, stuck);

  const r = await mgr.dispatchTrigger({
    ticketId: 'ticket-stuck2',
    role: 'assignee',
    triggerId: 'trig-after-unhealthy',
    agentId: 'agent-1',
    rolePrompt: '',
    ticketPrompt: '',
    columnPrompt: null,
    ticket: { title: 'Stuck2' },
    forceRespawn: false,
    maxConcurrentTicketsPerAgent: 5,
  });
  assert.equal(r.dispatched, true);
  assert.equal(r.firstTurn, true, 'fresh spawn, not a reused follow-up');
  assert.equal(mgr.spawnCount, 1, 'one fresh spawn');
  assert.equal(mgr.followUps.length, 0, 'no follow-up written into the dead session');
  assert.notEqual(r.pid, ALIVE_PID, 'new pid, not the stuck one');
});

// ─── Scope ③: agent-driven session split (escape hatch) ──────────────────
// Acceptance (d): an explicit split signal from the running subagent makes
// the NEXT trigger branch into a fresh session; otherwise the default reuse
// holds.

function assistantTextLine(text) {
  // Mirror the Claude stream-json `assistant` envelope the manager parses.
  return {
    stage: null,
    isResult: false,
    raw: { type: 'assistant', message: { content: [{ type: 'text', text }] } },
  };
}

test('ticket-session: split sentinel in assistant text arms the split flag', async () => {
  const mgr = new FakeTicketMgr(makeConfig(), 5);
  const base = {
    ticketId: 'ticket-split',
    role: 'assignee',
    agentId: 'agent-1',
    rolePrompt: '',
    ticketPrompt: '',
    columnPrompt: null,
    ticket: { title: 'Split' },
    forceRespawn: false,
    maxConcurrentTicketsPerAgent: 5,
  };
  await mgr.dispatchTrigger({ ...base, triggerId: 's1' });
  const sess = mgr._sessions.get('ticket-split:assignee:agent-1');
  assert.ok(sess, 'session exists');
  assert.notEqual(sess.splitRequested, true, 'not split yet');

  mgr._onStdoutParsed(
    sess,
    assistantTextLine('Done with this phase. [[AWB:SESSION_SPLIT]] starting unrelated refactor'),
    '',
  );
  assert.equal(sess.splitRequested, true, 'split armed');
  assert.equal(sess.splitReason, 'starting unrelated refactor', 'reason captured');
});

test('ticket-session: armed split makes the next trigger force-respawn a fresh session', async () => {
  const mgr = new FakeTicketMgr(makeConfig(), 5);
  const base = {
    ticketId: 'ticket-split2',
    role: 'assignee',
    agentId: 'agent-1',
    rolePrompt: '',
    ticketPrompt: '',
    columnPrompt: null,
    ticket: { title: 'Split2' },
    forceRespawn: false,
    maxConcurrentTicketsPerAgent: 5,
  };
  const r1 = await mgr.dispatchTrigger({ ...base, triggerId: 's1' });
  const sess = mgr._sessions.get('ticket-split2:assignee:agent-1');
  mgr._onStdoutParsed(sess, assistantTextLine('[[AWB:SESSION_SPLIT]] reason here'), '');
  assert.equal(sess.splitRequested, true);

  const r2 = await mgr.dispatchTrigger({ ...base, triggerId: 's2' });
  assert.equal(mgr.spawnCount, 2, 'a second (fresh) session was spawned');
  assert.equal(r2.firstTurn, true, 'next trigger is a first-turn fresh spawn');
  assert.notEqual(r2.pid, r1.pid, 'new pid — split, not reuse');
  assert.equal(mgr.followUps.length, 0, 'no follow-up turn into the old session');
});

test('ticket-session: WITHOUT a split sentinel the next trigger reuses the session (default policy)', async () => {
  const mgr = new FakeTicketMgr(makeConfig(), 5);
  const base = {
    ticketId: 'ticket-nosplit',
    role: 'assignee',
    agentId: 'agent-1',
    rolePrompt: '',
    ticketPrompt: '',
    columnPrompt: null,
    ticket: { title: 'NoSplit' },
    forceRespawn: false,
    maxConcurrentTicketsPerAgent: 5,
  };
  const r1 = await mgr.dispatchTrigger({ ...base, triggerId: 'n1' });
  const sess = mgr._sessions.get('ticket-nosplit:assignee:agent-1');
  // A quoted mention of the token must NOT false-arm a split when it isn't the
  // real sentinel — but our token is literal, so feed unrelated text instead.
  mgr._onStdoutParsed(sess, assistantTextLine('Continuing work, no split needed.'), '');
  assert.notEqual(sess.splitRequested, true, 'no split armed');
  const r2 = await mgr.dispatchTrigger({ ...base, triggerId: 'n2' });
  assert.equal(mgr.spawnCount, 1, 'reused — no second spawn');
  assert.equal(r2.pid, r1.pid, 'same pid (reuse)');
  assert.equal(mgr.followUps.length, 1, 'one follow-up turn');
});

// ─── Comment-mention 타깃 배달(T7 리뷰 blocker #3) ───────────────────────
// forwardCommentMention 은 per-agent 스코프 comment_mention 의 타깃 agent 에게만
// 배달해야 한다: 타깃 미라이브면 false(one-shot 스폰 경로 보존), 타깃 라이브면
// 그 세션에만(다른 공동 홀더 세션 오배달 금지), 타깃 미상(레거시)은 종전
// 브로드캐스트.

async function spawnHolderSession(mgr, ticketId, agentId, triggerId) {
  return mgr.dispatchTrigger({
    ticketId, role: 'assignee', agentId, triggerId,
    rolePrompt: '', ticketPrompt: '', columnPrompt: null,
    ticket: { title: 'Mention' }, forceRespawn: false,
    maxConcurrentTicketsPerAgent: 5,
  });
}

test('ticket-session: 타깃 홀더가 미라이브면 forwardCommentMention 은 false — 다른 홀더 세션을 훔치지 않는다', async () => {
  const mgr = new FakeTicketMgr(makeConfig(), 5);
  await spawnHolderSession(mgr, 'ticket-mention-a', 'agent-A', 'tA');
  const before = mgr.followUps.length;
  const forwarded = mgr.forwardCommentMention(
    'ticket-mention-a',
    { content: '재논의합시다', mention_source: 'role', role_shortcut: 'assignee', actor_name: 'reviewer' },
    'agent-B', // B 몫 멘션 — B 는 라이브 세션 없음
  );
  assert.equal(forwarded, false, 'B 몫 멘션이 A 세션 존재만으로 true 가 되면 B 의 one-shot 이 스킵된다(멘션 소실)');
  assert.equal(mgr.followUps.length, before, 'A 세션에 중복 주입되면 안 됨');
});

test('ticket-session: 타깃 홀더 라이브 → 그 세션에만 배달(공동 홀더 오배달 금지)', async () => {
  const mgr = new FakeTicketMgr(makeConfig(), 5);
  const rA = await spawnHolderSession(mgr, 'ticket-mention-b', 'agent-A', 'tA');
  const rB = await spawnHolderSession(mgr, 'ticket-mention-b', 'agent-B', 'tB');
  const before = mgr.followUps.length;
  const forwarded = mgr.forwardCommentMention(
    'ticket-mention-b',
    { content: 'B 님 의견 주세요', mention_source: 'direct', actor_name: 'reviewer' },
    'agent-B',
  );
  assert.equal(forwarded, true);
  const delivered = mgr.followUps.slice(before);
  assert.equal(delivered.length, 1, '타깃 한 세션에만 배달');
  assert.equal(delivered[0].pid, rB.pid, 'B 세션이 수신');
  assert.notEqual(delivered[0].pid, rA.pid, '"addressed to YOU" 가 A 에게 가면 오배달');
});

test('ticket-session: 타깃 미상(레거시 이벤트)은 종전 브로드캐스트 폴백 유지', async () => {
  const mgr = new FakeTicketMgr(makeConfig(), 5);
  const rA = await spawnHolderSession(mgr, 'ticket-mention-c', 'agent-A', 'tA');
  const rB = await spawnHolderSession(mgr, 'ticket-mention-c', 'agent-B', 'tB');
  const before = mgr.followUps.length;
  const forwarded = mgr.forwardCommentMention(
    'ticket-mention-c',
    { content: '모두 확인', mention_source: 'direct', actor_name: 'user' },
  );
  assert.equal(forwarded, true);
  const pids = mgr.followUps.slice(before).map((f) => f.pid).sort();
  assert.deepEqual(pids, [rA.pid, rB.pid].sort(), '레거시(타깃 미상)는 전 세션 배달 무회귀');
});

// ─── Chat-session dedup ─────────────────────────────────────────────────

test('chat-session: burst of two messages on same (room, agent) produces ONE spawn', async () => {
  const mgr = new FakeChatMgr(makeConfig(), 40);
  const base = {
    roomId: 'room-burst',
    agentId: 'agent-1',
    senderId: 'sender-A',
    senderName: 'Alice',
    content: 'hello',
    rolePrompt: '',
  };
  // Different createdAt so the per-message dedup table doesn't reject — the
  // in-flight guard is what we want to exercise.
  const p1 = mgr.dispatch({ ...base, createdAt: '2026-05-24T07:00:00.000Z' });
  const p2 = mgr.dispatch({ ...base, createdAt: '2026-05-24T07:00:01.000Z' });
  const [r1, r2] = await Promise.all([p1, p2]);

  assert.equal(mgr.spawnCount, 1, 'exactly one spawn across the burst');
  assert.equal(r1.dispatched, true);
  assert.equal(r1.firstTurn, true);
  assert.equal(r2.dispatched, false);
  assert.equal(r2.reason, 'inflight_spawn');
});

test('chat-session: second message AFTER first spawn lands collapses to follow-up turn on same pid', async () => {
  const mgr = new FakeChatMgr(makeConfig(), 5);
  const base = {
    roomId: 'room-follow',
    agentId: 'agent-1',
    senderId: 'sender-A',
    senderName: 'Alice',
    rolePrompt: '',
  };
  const r1 = await mgr.dispatch({
    ...base,
    content: 'hello',
    createdAt: '2026-05-24T07:00:00.000Z',
  });
  const r2 = await mgr.dispatch({
    ...base,
    content: 'how are you?',
    createdAt: '2026-05-24T07:00:01.000Z',
  });

  assert.equal(mgr.spawnCount, 1, 'no second spawn');
  assert.equal(r1.dispatched, true);
  assert.equal(r2.dispatched, true);
  assert.equal(r2.pid, r1.pid, 'second message reuses the same pid');
  assert.equal(r2.firstTurn, undefined);
  assert.equal(mgr.followUps.length, 1, 'exactly one follow-up turn was written');
  assert.ok(mgr.followUps[0].turnText.startsWith('how are you?\n\nTurn policy:\n'));
  assert.ok(mgr.followUps[0].turnText.includes('Reuse any run id or open capability ticket'));
});

test('chat-session: different agents in same room each spawn their own session', async () => {
  const mgr = new FakeChatMgr(makeConfig(), 5);
  const base = {
    roomId: 'room-shared',
    senderId: 'sender-A',
    senderName: 'Alice',
    content: 'hi',
    rolePrompt: '',
    createdAt: '2026-05-24T07:00:00.000Z',
  };
  const r1 = await mgr.dispatch({ ...base, agentId: 'agent-1' });
  const r2 = await mgr.dispatch({ ...base, agentId: 'agent-2' });
  assert.equal(mgr.spawnCount, 2, 'two distinct (room, agent) pairs spawn separately');
  assert.notEqual(r1.pid, r2.pid);
});

test('chat-session: dedup mark is rolled back when in-flight guard drops the second dispatch', async () => {
  // Regression: an earlier draft of the chat-session inflight guard would
  // leave the dedup table marked with the dropped event's id, which then
  // swallowed the genuine follow-up message that arrived after the spawn
  // completed. The current implementation rolls back via `_forgetDedup`
  // so the next event reaches `dispatchTrigger`'s normal flow.
  const mgr = new FakeChatMgr(makeConfig(), 40);
  const base = {
    roomId: 'room-rollback',
    agentId: 'agent-1',
    senderId: 'sender-A',
    senderName: 'Alice',
    content: 'first',
    rolePrompt: '',
  };
  const droppedStamp = '2026-05-24T07:00:01.000Z';
  const p1 = mgr.dispatch({ ...base, createdAt: '2026-05-24T07:00:00.000Z' });
  const p2 = mgr.dispatch({ ...base, createdAt: droppedStamp, content: 'second' });
  const [, r2] = await Promise.all([p1, p2]);
  assert.equal(r2.dispatched, false);
  assert.equal(r2.reason, 'inflight_spawn');
  // Re-dispatching with the same `createdAt` after the inflight clears
  // should now find the live session and send a follow-up — proving the
  // dedup mark was rolled back.
  const r3 = await mgr.dispatch({ ...base, createdAt: droppedStamp, content: 'second-retry' });
  assert.equal(r3.dispatched, true);
  assert.equal(mgr.followUps.length, 1);
  assert.ok(mgr.followUps[0].turnText.startsWith('second-retry\n\nTurn policy:\n'));
  assert.ok(mgr.followUps[0].turnText.includes('Reuse any run id or open capability ticket'));
});
