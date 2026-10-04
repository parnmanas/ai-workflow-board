// 작업 보고 — docs/voice-operator.md "작업 보고".
//
// AWB 를 거쳐 연결된 세션의 턴이 끝나거나(오류 포함) 사용자의 결정을 기다리면, AWB 가 알아채 operator 에게
// 보고하고, operator 가 쓴 요약이 사용자에게 간다. 고정하는 것:
//   1. 받을 operator: 같은 호스트(여럿이면 최근에 대화한 쪽), 없으면 가장 최근에 대화한 operator, 기록이
//      없으면 등록 순서. 대화 시각은 AWB 가 보낸 보고 턴이 아니라 사용자가 시작한 턴으로 센다.
//   2. 보고는 operator 세션에 대신 보낸 프롬프트다 — 장비 · CLI · 제목 · 길이 · 마지막 답(권한 요청이면 무엇을
//      허락할지와 선택지)을 싣고, 그 턴이 끝나면 operator 의 답이 `operator_report` 알림으로 driver 에게 간다.
//      화면 이동은 결정이 필요한 세션이 먼저다.
//   3. 사용자가 그 세션 화면을 보고 있으면 보고하지 않는다.
//   4. operator 가 바쁘면 줄 세웠다가 한가해질 때 묶어서 한 번에 보낸다.
//   5. 조용히 버리지 않는다: 닿지 못하면 다음 operator, 아무도 안 되거나 operator 가 답하지 못하면(턴 실패),
//      결정이 급한데 operator 가 계속 바쁘면 템플릿 문장으로 직접 알린다.
//   6. operator 자신의 턴은 보고하지 않는다 — 사용자가 그 화면을 떠나 있으면 operator 의 답을 그대로 들려준다.
//
// 실행: node --test test/voice-operator-reports.test.mjs (dist 필요)

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { encrypt } from '../dist/services/encryption.service.js';
import { activityEvents } from '../dist/services/activity.service.js';
import { invalidateVoiceConfig } from '../dist/modules/voice/voice-config.js';
import { VoiceService } from '../dist/modules/voice/voice.service.js';
import { VoiceAnnouncerService } from '../dist/modules/voice/voice-announcer.service.js';
import { OperatorReportService, URGENT_REPORT_WAIT_MS } from '../dist/modules/voice/operator-report.service.js';
import { VoicePresenceService } from '../dist/modules/voice/voice-presence.service.js';
import { OPERATORS_SETTING_KEY, invalidateOperatorCache } from '../dist/modules/voice/operator-config.js';
import { OPERATOR_REPORT_PREFIX, composeReportPrompt, routeOperators } from '../dist/modules/voice/operator-report.js';

process.env.ENCRYPTION_KEY ??= 'voice-operator-reports-test-key';

const operator = (id, managerId, over = {}) => ({
  id, name: id, aliases: [], manager_id: managerId, cli: 'claude', session_id: `op-${id}`, cwd: '/home/parn/awb-operator', title: '',
  workspace_id: 'ws-1', last_conversation_at: '', created_at: '', created_by: 'u1', updated_at: '', ...over,
});

function setup(operators, { prompt } = {}) {
  const settings = {
    'voice.tts.provider': 'openai',
    'voice.openai.api_key': 'sk-test',
    'voice.stt.languages': 'ko,en',
  };
  const rows = Object.entries(settings).map(([key, value]) => ({ key, value: key.endsWith('.api_key') ? encrypt(value) : value }));
  const stored = new Map([[OPERATORS_SETTING_KEY, { key: OPERATORS_SETTING_KEY, value: JSON.stringify(operators) }]]);
  const repos = {
    SystemSetting: {
      find: async () => rows,
      findOne: async ({ where }) => (stored.has(where.key) ? { ...stored.get(where.key) } : null),
      create: (v) => ({ ...v }),
      save: async (row) => { stored.set(row.key, { ...row }); return row; },
      remove: async (row) => { stored.delete(row.key); return row; },
    },
    AgentSessionCliSetting: { findOne: async () => null },
  };
  const dataSource = { getRepository: (name) => repos[name] };
  const log = { warn() {}, error() {}, info() {}, debug() {} };
  invalidateVoiceConfig();
  invalidateOperatorCache();
  const voice = new VoiceService(dataSource, log);
  const prompts = [];
  let turn = 0;
  const prompter = {
    promptOnBehalf: async (workspaceId, userId, managerId, cli, sessionId, text) => {
      if (prompt) await prompt({ managerId, sessionId });
      const turn_id = `report-turn-${++turn}`;
      prompts.push({ workspaceId, userId, managerId, cli, sessionId, text, turn_id });
      return { turn_id, live: {} };
    },
  };
  const presence = new VoicePresenceService();
  const reports = new OperatorReportService(dataSource, prompter, log);
  const announcer = new VoiceAnnouncerService(dataSource, voice, log, { listSubjects: async () => [] }, reports, presence);
  announcer.onModuleInit();
  const heard = [];
  const onAnnounce = (p) => heard.push(p);
  activityEvents.on('voice_announcement', onAnnounce);
  const teardown = () => {
    announcer.onModuleDestroy();
    activityEvents.removeListener('voice_announcement', onAnnounce);
  };
  const storedOperators = () => JSON.parse(stored.get(OPERATORS_SETTING_KEY).value);
  return { heard, prompts, presence, reports, teardown, storedOperators };
}

const flush = () => new Promise((r) => setTimeout(r, 30));
const session = (managerId, sessionId, over = {}) => ({
  manager_id: managerId, manager_name: managerId === 'host-rolf' ? 'rolf' : 'ragnar', cli: 'codex', session_id: sessionId,
  title: '배포 정리', cwd: '/home/parn/repo', status: 'ready', driver_user_id: 'u1', ...over,
});
const update = (s, reason) => activityEvents.emit('agent_session_update', { session: s, reason, driver_user_id: 'u1', timestamp: new Date().toISOString() });
const event = (s, type, payload, turnId) => activityEvents.emit('agent_session_event', {
  manager_id: s.manager_id, cli: s.cli, session_id: s.session_id, driver_user_id: 'u1',
  event: { id: `${type}-${Math.random()}`, seq: 0, turn_id: turnId, type, payload, created_at: new Date().toISOString() },
});
/** 세션 턴 하나를 끝낸다(답 → 끝). */
function finishTurn(s, turnId, answer) {
  event(s, 'text', { text: answer }, turnId);
  event(s, 'turn', { phase: 'finished', stop_reason: 'end_turn' }, turnId);
  update(s, 'turn_finished');
}
const opSession = (op) => ({ manager_id: op.manager_id, manager_name: 'rolf', cli: op.cli, session_id: op.session_id, title: '', cwd: op.cwd, status: 'ready', driver_user_id: 'u1' });

test('routing: same host first, else the operator talked to most recently, else registration order', () => {
  const a = operator('a', 'host-rolf');
  const b = operator('b', 'host-ragnar', { last_conversation_at: '2026-10-04T10:00:00.000Z' });
  const c = operator('c', 'host-ralf', { last_conversation_at: '2026-10-04T11:00:00.000Z' });
  const d = operator('d', 'host-rolf', { last_conversation_at: '2026-10-04T09:00:00.000Z' });
  const ids = (list) => list.map((op) => op.id).join(',');
  assert.equal(ids(routeOperators([a, b, c, d], 'host-rolf')), 'd,a,c,b', 'same host first — the one talked to more recently ahead');
  assert.equal(ids(routeOperators([a, b, c, d], 'host-mac')), 'c,b,d,a', 'no operator on that host — most recent conversation');
  assert.equal(ids(routeOperators([a, operator('e', 'host-x')], 'host-mac')), 'a,e', 'no history — registration order');
  assert.equal(ids(routeOperators([b, c], 'host-mac', new Map([['b', Date.parse('2026-10-04T12:00:00.000Z')]]))), 'b,c', 'a conversation this process saw beats the stored time');
});

test('a finished turn is reported to the same-host operator; its summary reaches the driver', async (t) => {
  const jarvis = operator('jarvis', 'host-rolf');
  const friday = operator('friday', 'host-ragnar', { last_conversation_at: new Date().toISOString() });
  const { heard, prompts, teardown } = setup([jarvis, friday]);
  t.after(teardown);
  const s = session('host-rolf', 's1');
  event(s, 'text', { text: '확인해 볼게요.' }, 't1');
  event(s, 'tool_call', { tool_call_id: 'x' }, 't1');
  finishTurn(s, 't1', '배포가 끝났고 테스트 280개가 모두 통과했어요.');
  await flush();
  assert.equal(prompts.length, 1);
  assert.deepEqual([prompts[0].managerId, prompts[0].sessionId, prompts[0].userId, prompts[0].workspaceId], ['host-rolf', 'op-jarvis', 'u1', 'ws-1'],
    'the same-host operator wins over the more recently used one elsewhere');
  const text = prompts[0].text;
  assert.ok(text.startsWith(OPERATOR_REPORT_PREFIX));
  assert.match(text, /1\. 완료 — rolf \/ Codex · '배포 정리'/);
  assert.match(text, /작업 폴더: \/home\/parn\/repo/);
  assert.match(text, /테스트 280개가 모두 통과했어요/);
  assert.equal(heard.length, 0, 'the session itself says nothing — the operator does');

  // operator 의 보고 턴이 끝난다 → 그 답이 요약으로 driver 에게.
  const op = opSession(jarvis);
  event(op, 'turn', { phase: 'started' }, prompts[0].turn_id);
  finishTurn(op, prompts[0].turn_id, '롤프의 배포 정리 세션이 끝났어요. 테스트 280개가 모두 통과했습니다.\n\n| 표 | 상세 |');
  await flush();
  assert.equal(heard.length, 1);
  assert.equal(heard[0].kind, 'operator_report');
  assert.equal(heard[0].user_id, 'u1');
  assert.equal(heard[0].text, '롤프의 배포 정리 세션이 끝났어요. 테스트 280개가 모두 통과했습니다.');
  assert.deepEqual(heard[0].operator, { id: 'jarvis', name: 'jarvis' });
  assert.deepEqual(heard[0].target, { type: 'session', manager_id: 'host-rolf', cli: 'codex', session_id: 's1' }, 'tapping it opens the session that finished');
});

test('nothing is reported while the user is looking at that session', async (t) => {
  const { heard, prompts, presence, teardown } = setup([operator('jarvis', 'host-rolf')]);
  t.after(teardown);
  const s = session('host-rolf', 's1');
  presence.update('u1', 'tab-1', { manager_id: 'host-rolf', cli: 'codex', session_id: 's1' }, true);
  finishTurn(s, 't1', '끝났어요.');
  await flush();
  assert.equal(prompts.length, 0);
  presence.update('u1', 'tab-1', { manager_id: 'host-rolf', cli: 'codex', session_id: 's1' }, false); // 탭이 숨었다
  finishTurn(s, 't2', '또 끝났어요.');
  await flush();
  assert.equal(prompts.length, 1, 'a hidden tab is not looking');
  assert.equal(heard.length, 0);
});

test('a permission request is reported with what to allow; the summary points at that session', async (t) => {
  const jarvis = operator('jarvis', 'host-rolf');
  const { heard, prompts, teardown } = setup([jarvis]);
  t.after(teardown);
  const s = session('host-ragnar', 's9', { title: '모델 서버' });
  event(s, 'permission_request', {
    request_id: 'r1', title: 'Run npm publish', options: [{ option_id: 'a', name: 'Allow once' }, { option_id: 'r', name: 'Reject' }],
  }, 't1');
  update({ ...s, status: 'awaiting_permission' }, 'permission');
  await flush();
  assert.equal(prompts.length, 1, 'no operator on ragnar — the only one gets it');
  assert.match(prompts[0].text, /1\. 승인 필요 — ragnar \/ Codex · '모델 서버'/);
  assert.match(prompts[0].text, /Run npm publish\n\s+선택지: Allow once \/ Reject/);
  finishTurn(opSession(jarvis), prompts[0].turn_id, "ragnar의 모델 서버 세션이 npm publish 실행 허락을 기다려요. 세션 화면에서 허용하거나 거부해 주세요.");
  await flush();
  assert.equal(heard.length, 1);
  assert.deepEqual(heard[0].target, { type: 'session', manager_id: 'host-ragnar', cli: 'codex', session_id: 's9' });
});

test('a busy operator gets the reports together once it is free', async (t) => {
  const jarvis = operator('jarvis', 'host-rolf');
  let busy = true;
  const { prompts, teardown } = setup([jarvis], {
    prompt: async () => { if (busy) throw Object.assign(new Error('A turn is already in progress.'), { code: 'session_busy' }); },
  });
  t.after(teardown);
  finishTurn(session('host-rolf', 's1', { title: '하나' }), 't1', '첫 번째 끝.');
  finishTurn(session('host-rolf', 's2', { title: '둘' }), 't2', '두 번째 끝.');
  await flush();
  assert.equal(prompts.length, 0, 'queued while the operator talks with the user');
  busy = false;
  // 사용자와의 대화 턴이 끝났다 → 줄 선 보고를 묶어서 보낸다.
  const op = opSession(jarvis);
  event(op, 'turn', { phase: 'started' }, 'user-turn');
  finishTurn(op, 'user-turn', '네, 알겠습니다.');
  await flush();
  assert.equal(prompts.length, 1, 'one prompt for both');
  assert.match(prompts[0].text, /소식 2건/);
  assert.match(prompts[0].text, /1\. 완료 — rolf \/ Codex · '하나'/);
  assert.match(prompts[0].text, /2\. 완료 — rolf \/ Codex · '둘'/);
});

test('an unreachable operator passes the report on; with no one left it is announced directly', async (t) => {
  const jarvis = operator('jarvis', 'host-rolf');
  const friday = operator('friday', 'host-ragnar');
  const offline = new Set(['host-rolf']);
  const { heard, prompts, teardown } = setup([jarvis, friday], {
    prompt: async ({ managerId }) => {
      if (offline.has(managerId)) throw Object.assign(new Error('This Runtime Host is not connected right now.'), { code: 'host_offline' });
    },
  });
  t.after(teardown);
  finishTurn(session('host-rolf', 's1'), 't1', '끝났어요.');
  await flush();
  assert.deepEqual(prompts.map((p) => p.sessionId), ['op-friday'], 'rolf is down — the next operator gets it');
  finishTurn(opSession(friday), prompts[0].turn_id, '롤프 세션이 끝났어요.');
  await flush();
  assert.equal(heard.length, 1);

  offline.add('host-ragnar');
  update({ ...session('host-rolf', 's2'), status: 'error', last_error: 'boom' }, 'turn_failed');
  await flush();
  assert.equal(prompts.length, 1);
  assert.equal(heard.length, 2, 'nobody to report to — said directly instead of dropped');
  assert.equal(heard[1].kind, 'session_turn_failed');
  assert.equal(heard[1].text, "rolf의 Codex 세션 '배포 정리'에서 오류가 났어요.");
});

test('an operator that fails its report turn hands the news back as direct announcements', async (t) => {
  const jarvis = operator('jarvis', 'host-rolf');
  const { heard, prompts, teardown } = setup([jarvis]);
  t.after(teardown);
  finishTurn(session('host-rolf', 's1'), 't1', '배포 끝.');
  await flush();
  const op = opSession(jarvis);
  event(op, 'turn', { phase: 'finished', stop_reason: 'error' }, prompts[0].turn_id);
  update({ ...op, status: 'error' }, 'turn_failed');
  await flush();
  assert.equal(heard.length, 1);
  assert.equal(heard[0].kind, 'session_turn_finished');
  assert.match(heard[0].text, /^rolf의 Codex 세션 '배포 정리' 작업이 끝났어요\. 배포 끝\.$/);
});

test('a decision cannot wait for a busy operator forever', async (t) => {
  const jarvis = operator('jarvis', 'host-rolf');
  const { heard, prompts, reports, teardown } = setup([jarvis], {
    prompt: async () => { throw Object.assign(new Error('busy'), { code: 'session_busy' }); },
  });
  t.after(teardown);
  const s = session('host-rolf', 's1');
  update({ ...s, status: 'awaiting_input' }, 'elicitation');
  await flush();
  await reports.sweep(Date.now() + URGENT_REPORT_WAIT_MS - 5_000);
  assert.equal(heard.length, 0, 'still waiting for the operator');
  await reports.sweep(Date.now() + URGENT_REPORT_WAIT_MS + 1_000);
  await flush();
  assert.equal(prompts.length, 0);
  assert.equal(heard.length, 1);
  assert.equal(heard[0].kind, 'session_needs_input');
  assert.match(heard[0].text, /확인을 기다리고 있어요\.$/);
});

test("operators are not reported to operators; an operator's answer is spoken when you left its page", async (t) => {
  const jarvis = operator('jarvis', 'host-rolf');
  const friday = operator('friday', 'host-ragnar');
  const { heard, prompts, presence, storedOperators, teardown } = setup([jarvis, friday]);
  t.after(teardown);
  const op = opSession(jarvis);
  update(op, 'prompt');
  event(op, 'turn', { phase: 'started' }, 'u-turn-1');
  finishTurn(op, 'u-turn-1', '오늘 배포는 세 번 있었어요.\n```sh\nlog\n```');
  await flush();
  assert.equal(prompts.length, 0, "an operator's own turn is never a report");
  assert.equal(heard.length, 1);
  assert.equal(heard[0].kind, 'operator_reply');
  assert.equal(heard[0].text, '오늘 배포는 세 번 있었어요.');
  assert.deepEqual(heard[0].target, { type: 'session', manager_id: 'host-rolf', cli: 'claude', session_id: 'op-jarvis' });

  presence.update('u1', 'tab-1', { manager_id: 'host-rolf', cli: 'claude', session_id: 'op-jarvis' }, true);
  event(op, 'turn', { phase: 'started' }, 'u-turn-2');
  finishTurn(op, 'u-turn-2', '네.');
  await flush();
  assert.equal(heard.length, 1, 'the operator page reads it itself');

  // 사용자가 시작한 턴은 "최근 대화" 로 남는다 → 다른 호스트의 세션 보고가 jarvis 로 간다.
  assert.ok(storedOperators().find((o) => o.id === 'jarvis').last_conversation_at, 'the conversation time is kept for the next boot');
  finishTurn(session('host-mac', 's5'), 't5', '맥에서 끝났어요.');
  await flush();
  assert.deepEqual(prompts.map((p) => p.sessionId), ['op-jarvis']);
});

test('the report prompt is bounded and speaks English when configured', () => {
  const long = 'x'.repeat(5000);
  const text = composeReportPrompt([{
    kind: 'finished', user_id: 'u1', detail: long, duration_ms: 125_000, at: 0,
    session: { manager_id: 'h', manager_name: 'rolf', cli: 'claude', cli_label: 'Claude Code', session_id: 's', title: 'Deploy', cwd: '' },
  }], 'en');
  assert.ok(text.startsWith(`${OPERATOR_REPORT_PREFIX} 1 update(s)`));
  assert.match(text, /1\. finished — rolf \/ Claude Code · "Deploy" · 2 min/);
  assert.ok(text.length < 2000, 'details are clipped');
  assert.match(text, /…\(truncated\)/);
});

test('the screen recognises the same report prefix and sleep marker the server uses', () => {
  const client = readFileSync(new URL('../../client/src/voice/wake.logic.ts', import.meta.url), 'utf8');
  assert.ok(client.includes(`export const OPERATOR_REPORT_PREFIX = '${OPERATOR_REPORT_PREFIX}';`), 'client folds reports by this exact prefix');
  assert.ok(client.includes("export const SLEEP_MARKER = '[[sleep]]';"), 'client and server agree on the sleep marker');
});
