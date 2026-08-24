// Run-completion backstop (ticket 152e3606, 요구사항 3) — untrusted-workspace
// 사고를 추적하다 발견한 간극을 다룬다: run에 묶인 세션이 턴 도중에 멈추면
// (예: 비대화형 run에서 아무도 승인해줄 수 없는 permission 승인 대기에 영원히
// 걸린 경우) 턴-종료 RESULT 라인을 절대 못 내므로, 기존 턴-종료 orphan sweep들
// (ChatSessionManager#_sweepTurnEndOrphans / SubagentManager#_sweepOneshotRunOrphans,
// ticket 89716f04/55d3063f)이 아예 armed되지 않고 run을 종료 처리하지 못한다.
// 이 티켓 이전에는 그 뒤로 아무것도 complete_qa_run / complete_security_run /
// complete_action_run을 호출하지 않았으므로, 로컬 프로세스가 죽은 뒤에도
// (idle-timer / health-watchdog / TTL sweep / crash) run은 서버에서 영원히
// `running`으로 남았다.
//
// ChatSessionManager#_onChildExit와 SubagentManager#_runExitCompletionBackstop이
// 이를 위해 추가된, exit마다 도는 범용 backstop이다: exit하는 세션/record가
// 여전히 run 바인딩을 갖고 있으면 그 run의 종료 도구를 실패 상태로 무조건
// 호출한다. 에이전트가 이미 run을 정상 종료 처리한 경우에도 이 호출은
// 안전한데, complete_*_run의 terminal 전이가 서버 쪽에서 원자적으로
// 멱등이기 때문이다(actions.service.ts의 completeRun, `status = 'running'`
// 가드) — 이 테스트 스위트는 CLIENT 쪽이 항상 그 호출을 시도한다는 것만
// 증명하고, 서버 쪽 no-op 보장 자체는 이 패키지 테스트 범위 밖이다.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { ChatSessionManager } from '../dist/lib/chat-session-manager.js';
import { SubagentManager } from '../dist/lib/subagent-manager.js';

function makeConfig() {
  return {
    url: 'http://127.0.0.1:0',
    apiKey: 'test-key',
    silentExitVerifyDelayMs: 0,
    delegation: { enabled: true, maxConcurrent: 10, ttlMinutes: 15, idleMinutes: 999, maxTurnsPerSession: 999 },
  };
}

let originalFetch;
let mcpToolCalls; // /mcp로 들어온 모든 tools/call의 { name, args }

beforeEach(() => {
  originalFetch = globalThis.fetch;
  mcpToolCalls = [];
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
        mcpToolCalls.push({ name: body.params?.name, args: body.params?.arguments });
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '{}' }] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('', { status: 202 }); // notifications/initialized
    }
    return new Response('{}', { status: 201, headers: { 'content-type': 'application/json' } });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── ChatSessionManager#_onChildExit (persistent / chat-room run 경로) ────────

function makeChatSession(pid, overrides = {}) {
  return {
    sessionKey: `room-${pid}|agent-1`,
    pid,
    roomId: `room-${pid}`,
    agentId: 'agent-1',
    cli_type: 'claude',
    adapter: {
      cliType: 'claude',
      formatTurn: (s) => String(s),
      parseStdoutLine: () => ({ stage: null, isResult: false, raw: null }),
    },
    child: { pid, stdin: { write: () => true, end: () => {} }, once: () => {} },
    configPath: null,
    configPathIsTemp: false,
    pidPath: null,
    turnCount: 1,
    startedAt: Date.now(),
    lastTouchedAt: Date.now(),
    idleTimer: null,
    unrespondedTurnCount: 0,
    unrespondedSince: null,
    unhealthyKilled: false,
    tap: null,
    ...overrides,
  };
}

test('ChatSessionManager._onChildExit: 한 번도 응답 못 한 run-bound 세션 → run을 failed/error로 종료 처리', async () => {
  const mgr = new ChatSessionManager(makeConfig());
  const sess = makeChatSession(40001, {
    _run: { run_id: 'run-hang-1', workspace_id: 'ws-1', kind: 'action' },
  });
  await mgr._onChildExit(sess, null, 'SIGTERM'); // idle-timer/health-watchdog에 의해 kill됨, result 라인은 한 번도 없었음

  const call = mcpToolCalls.find((c) => c.name === 'complete_action_run');
  assert.ok(call, 'complete_action_run이 호출돼야 한다 — run을 영원히 running으로 남겨둘 수 없다');
  assert.equal(call.args.run_id, 'run-hang-1');
  assert.equal(call.args.workspace_id, 'ws-1');
  assert.equal(call.args.status, 'failed', "resolveRunCompletionRoute 기준 action의 failureStatus는 'failed'다");
  assert.ok(call.args.summary && call.args.summary.length > 0, 'summary에 실패 사유가 담겨 있어야 한다');
});

test('ChatSessionManager._onChildExit: qa 종류 run은 complete_qa_run으로 라우팅되고 status=error', async () => {
  const mgr = new ChatSessionManager(makeConfig());
  const sess = makeChatSession(40002, {
    _run: { run_id: 'run-hang-2', workspace_id: 'ws-1', kind: 'qa' },
  });
  await mgr._onChildExit(sess, 0, null);

  const call = mcpToolCalls.find((c) => c.name === 'complete_qa_run');
  assert.ok(call, 'qa 종류 run은 complete_action_run이 아니라 complete_qa_run으로 라우팅돼야 한다');
  assert.equal(call.args.status, 'error', "resolveRunCompletionRoute 기준 qa/security의 failureStatus는 'error'다");
});

test('ChatSessionManager._onChildExit: 보통 세션(_run 없음)은 어떤 run-completion 도구도 호출하지 않음', async () => {
  const mgr = new ChatSessionManager(makeConfig());
  const sess = makeChatSession(40003); // _run 없음 — 보통의 chat/ticket 디스패치
  await mgr._onChildExit(sess, 0, null);
  assert.equal(
    mcpToolCalls.some((c) => /^complete_(action|qa|security)_run$/.test(c.name || '')),
    false,
    'run에 묶인 적 없는 세션은 어떤 run-completion 호출도 유발하면 안 된다',
  );
});

test("ChatSessionManager._onChildExit: CLI의 untrusted-workspace 경고를 실패 summary로 승격한다", async () => {
  const mgr = new ChatSessionManager(makeConfig());
  const sess = makeChatSession(40004, {
    _run: { run_id: 'run-untrusted', workspace_id: 'ws-1', kind: 'action' },
  });
  // _collectOutputTail은 베이스 클래스의 pid별 출력 링(`_outputRings`, 실제
  // 운영에서는 stdio-capture 배선이 채운다)을 읽는다 — 그 필드를 클래스
  // 자신이 읽는 것과 동일하게 직접 시딩한다.
  mgr._outputRings.set(sess.pid, [
    'Ignoring 22 permissions.allow entries from .claude/settings.json: this workspace has',
    'not been trusted. Run Claude Code interactively here once and accept the trust dialog.',
  ]);
  await mgr._onChildExit(sess, null, 'SIGTERM');
  const call = mcpToolCalls.find((c) => c.name === 'complete_action_run' && c.args.run_id === 'run-untrusted');
  assert.ok(call, 'run은 여전히 종료 처리돼야 한다');
  assert.match(
    call.args.summary,
    /trust/i,
    '캡처된 tail 속 untrusted-workspace 경고가 실패 summary에 구체적으로 언급돼야 한다',
  );
});

test('ChatSessionManager._onChildExit: 흔한 hang(tail에 trust 경고 없음)은 일반 summary를 받는다', async () => {
  const mgr = new ChatSessionManager(makeConfig());
  const sess = makeChatSession(40005, {
    _run: { run_id: 'run-generic-hang', workspace_id: 'ws-1', kind: 'action' },
  });
  mgr._outputRings.set(sess.pid, ['assistant: still working...']);
  await mgr._onChildExit(sess, null, 'SIGTERM');
  const call = mcpToolCalls.find((c) => c.name === 'complete_action_run' && c.args.run_id === 'run-generic-hang');
  assert.ok(call);
  assert.doesNotMatch(call.args.summary, /workspace trust/, '관측한 적 없는 trust 원인을 주장하면 안 된다');
  // ticket b831b896 round 3: stopReason이 전혀 없는 경우(매니저가 죽인 게
  // 아닌 진짜 원인불명 종료) — 추측 문구 대신 정직하게 unknown이라고만
  // 기록해야 한다.
  assert.match(call.args.summary, /reason=unknown/, '원인을 모르면 모른다고 정확히 기록해야 한다');
  assert.doesNotMatch(
    call.args.summary,
    /idle-timer|health-watchdog|승인 대기 등으로 멈춰/,
    '원인을 모르는데 특정 메커니즘(idle-timer/health-watchdog)을 추측하면 안 된다',
  );
});

// ticket b831b896: 매니저 self-update 재시작이 in-flight 세션을 SIGTERM하면
// stop()이 sess.stopReason을 태그해 두고, 이 backstop이 idle-timer/
// health-watchdog 추측 대신 그 정확한 사유를 report한다.
test('ChatSessionManager._onChildExit: stopReason이 있으면 추측 문구 대신 정확한 사유를 기록한다', async () => {
  const mgr = new ChatSessionManager(makeConfig());
  const sess = makeChatSession(40006, {
    _run: { run_id: 'run-self-update', workspace_id: 'ws-1', kind: 'action' },
    stopReason: 'self_update_restart',
  });
  await mgr._onChildExit(sess, null, 'SIGTERM');
  const call = mcpToolCalls.find((c) => c.name === 'complete_action_run' && c.args.run_id === 'run-self-update');
  assert.ok(call, 'run은 여전히 종료 처리돼야 한다');
  assert.match(call.args.summary, /self_update_restart/, 'stopReason이 summary에 그대로 드러나야 한다');
  assert.doesNotMatch(
    call.args.summary,
    /idle-timer|health-watchdog|승인 대기 등으로 멈춰/,
    '원인을 아는데도 추측 문구를 쓰면 안 된다',
  );
});

test('ChatSessionManager.stop: 살아있는 run-bound 세션에 reason을 태그해 SIGTERM 이전에 남긴다', async () => {
  const mgr = new ChatSessionManager(makeConfig());
  const sess = makeChatSession(50001, {
    _run: { run_id: 'run-shutdown-tag', workspace_id: 'ws-1', kind: 'action' },
  });
  mgr._sessions.set(sess.sessionKey, sess);
  await mgr.stop('self_update_restart');
  assert.equal(sess.stopReason, 'self_update_restart', 'stop()이 SIGTERM 전에 sess.stopReason을 설정해야 한다');
});

// ticket b831b896 round 3: "각 kill 지점에서 reason을 태그" — stopForAgent
// (credential rotation)도 manager-initiated kill 지점 중 하나다.
test('ChatSessionManager.stopForAgent: 살아있는 세션에 credential_rotation을 태그해 SIGTERM 이전에 남긴다', async () => {
  const mgr = new ChatSessionManager(makeConfig());
  const sess = makeChatSession(50002, { agentId: 'agent-rotated' });
  mgr._sessions.set(sess.sessionKey, sess);
  await mgr.stopForAgent('agent-rotated');
  assert.equal(sess.stopReason, 'credential_rotation');
});

// ticket b831b896 round 4: reviewer가 지적한 마지막 미분류 kill 지점 —
// #evictLru(_ensureCapacity가 maxConcurrent에서 새 세션을 위해 가장 오래
// 안 건드린 세션을 reap)도 idle/max_turns와 같은 stdin.end() manager-
// initiated close이므로 동일하게 분류돼야 한다.
test('ChatSessionManager._ensureCapacity: maxConcurrent 도달 시 LRU 세션에 lru_eviction을 태그해 stdin.end() 이전에 남긴다', () => {
  const mgr = new ChatSessionManager({
    url: 'http://127.0.0.1:0',
    apiKey: 'test-key',
    delegation: { enabled: true, maxConcurrent: 1, ttlMinutes: 15, idleMinutes: 999, maxTurnsPerSession: 999 },
  });
  const older = makeChatSession(50003, {
    _run: { run_id: 'run-evicted', workspace_id: 'ws-1', kind: 'action' },
    lastTouchedAt: Date.now() - 100_000,
  });
  const newer = makeChatSession(50004, { lastTouchedAt: Date.now() });
  mgr._sessions.set(older.sessionKey, older);
  mgr._sessions.set(newer.sessionKey, newer);

  const ok = mgr._ensureCapacity();

  assert.equal(ok, true, 'eviction succeeded, room was made for a new spawn');
  assert.equal(older.stopReason, 'lru_eviction', 'evicted (older) 세션에 태그돼야 한다');
  assert.equal(mgr._sessions.has(older.sessionKey), false, '더 오래된 세션이 reap됐다');
  assert.equal(mgr._sessions.has(newer.sessionKey), true, '더 최근 세션은 살아남는다');
  assert.equal(newer.stopReason, undefined, '살아남은 세션은 태그되면 안 된다');
});

// ── SubagentManager._runExitCompletionBackstop (oneshot run 경로) ────────────

let pidSeq = 90000;
function makeOneshotRunRecord(overrides = {}) {
  return {
    pid: ++pidSeq,
    kind: 'trigger',
    cli_type: 'codex',
    trigger_id: null,
    chat_request_id: 'chat-1',
    ticket_id: '',
    agent_id: 'agent-rolf',
    role: undefined,
    room_id: 'room-1',
    started_at: Date.now(),
    config_path: null,
    config_path_is_temp: false,
    captureOutput: true,
    outLines: [],
    tailLines: [],
    commentSent: false,
    tap: null,
    ...overrides,
  };
}

test('SubagentManager._runExitCompletionBackstop: 결과 없이 끝난 run-bound record → failed로 종료 처리', async () => {
  const mgr = new SubagentManager(makeConfig());
  const record = makeOneshotRunRecord({
    run: { run_id: 'oneshot-hang-1', workspace_id: 'ws-1', kind: 'action' },
    tailLines: ['assistant: checking repo state', '→ tool(Bash)'],
  });
  await mgr._runExitCompletionBackstop(record, null);

  const call = mcpToolCalls.find((c) => c.name === 'complete_action_run');
  assert.ok(call, '멈춘 oneshot run에도 complete_action_run이 호출돼야 한다');
  assert.equal(call.args.run_id, 'oneshot-hang-1');
  assert.equal(call.args.status, 'failed');
});

test('SubagentManager._runExitCompletionBackstop: run 바인딩이 없으면 아무 일도 하지 않음', async () => {
  const mgr = new SubagentManager(makeConfig());
  const record = makeOneshotRunRecord(); // run을 undefined로 둠
  await mgr._runExitCompletionBackstop(record, 0);
  assert.equal(
    mcpToolCalls.some((c) => /^complete_(action|qa|security)_run$/.test(c.name || '')),
    false,
    'run 바인딩이 없는 보통의 oneshot record는 run-completion 호출을 유발하면 안 된다',
  );
});

test('SubagentManager._runExitCompletionBackstop: tail 속 untrusted-workspace 경고를 감지해 summary에 명시한다', async () => {
  const mgr = new SubagentManager(makeConfig());
  const record = makeOneshotRunRecord({
    run: { run_id: 'oneshot-untrusted', workspace_id: 'ws-1', kind: 'action' },
    tailLines: [
      'Ignoring 22 permissions.allow entries from .claude/settings.json: this workspace has',
      'not been trusted. Run Claude Code interactively here once and accept the trust dialog.',
    ],
  });
  await mgr._runExitCompletionBackstop(record, null);

  const call = mcpToolCalls.find((c) => c.name === 'complete_action_run' && c.args.run_id === 'oneshot-untrusted');
  assert.ok(call, 'run은 여전히 종료 처리돼야 한다');
  assert.match(
    call.args.summary,
    /trust/i,
    '캡처된 tail 속 untrusted-workspace 경고가 일반 메시지가 아니라 실패 summary에 명시돼야 한다',
  );
});

test('SubagentManager._runExitCompletionBackstop: 흔한 hang(tail에 trust 경고 없음)은 일반 summary를 받는다', async () => {
  const mgr = new SubagentManager(makeConfig());
  const record = makeOneshotRunRecord({
    run: { run_id: 'oneshot-generic-hang', workspace_id: 'ws-1', kind: 'security' },
    tailLines: ['assistant: working on it...'],
  });
  await mgr._runExitCompletionBackstop(record, null);

  const call = mcpToolCalls.find((c) => c.name === 'complete_security_run');
  assert.ok(call);
  assert.equal(call.args.status, 'error');
  assert.doesNotMatch(call.args.summary, /workspace trust/, '관측한 적 없는 trust 원인을 주장하면 안 된다');
  // ticket 6abe2b79 rebase 통합: stop()이 SIGTERM 전에 매니저發 kill마다
  // record.stopReason을 태그하므로(레코드 자체는 exit 핸들러가 정리),
  // 매니저發 kill은 이제 이 backstop에 정상 도달해 위 stopReason 분기로
  // 정확한 사유를 보고한다. 이 테스트의 record는 stopReason 없이 만들어져
  // 있으므로(진짜 원인불명 — crash, 승인 대기 등) 그 경우에만 추측 대신
  // 정직하게 unknown이라고 기록해야 한다는 것을 검증한다.
  assert.match(call.args.summary, /reason=unknown/, '원인을 모르면 모른다고 정확히 기록해야 한다');
  assert.doesNotMatch(
    call.args.summary,
    /TTL sweep|idle-timer|health-watchdog|승인 대기 등으로 멈춰/,
    '원인을 모르는데 TTL sweep/kill 같은 특정 메커니즘을 추측하면 안 된다',
  );
});
