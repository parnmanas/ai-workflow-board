// 음성 알림(VoiceAnnouncerService) 회귀 테스트 — docs/voice-operator.md "음성 알림".
//
// 고정하는 것:
//   1. 세션: 긴 턴이 끝나면(시작 시각을 모르면 긴 것으로 친다) driver 에게 알리고, 답의 첫머리를 싣는다.
//      짧은 턴·사용자가 멈춘 턴은 알리지 않는다. 오류는 길이와 무관하게 알린다.
//   2. 확인 대기(권한·질문)는 알리되, 같은 세션에서 연달아 오면 한 번만.
//   3. 미션: 종료 이벤트(mission_completed/failed/cancelled)와 결정 대기(confirm_notified)만 알린다 —
//      대상은 사람 소유자, 없으면 워크스페이스 owner.
//   4. 작업 알림음은 TTS 가 없어도 보낸다. 대화 답변만 TTS 가 필요하다.
//   5. 소리는 받는 사람만, 처음 요청될 때 한 번 합성한다.
//   6. 문장은 받침과 무관하게 맞는 조사만 쓴다(제목 바로 뒤에 이/가를 붙이지 않는다).

import assert from 'node:assert/strict';
import test from 'node:test';
import { encrypt } from '../dist/services/encryption.service.js';
import { activityEvents } from '../dist/services/activity.service.js';
import { invalidateVoiceConfig } from '../dist/modules/voice/voice-config.js';
import { VoiceService } from '../dist/modules/voice/voice.service.js';
import { VoiceAnnouncerService } from '../dist/modules/voice/voice-announcer.service.js';
import { OperatorReportService } from '../dist/modules/voice/operator-report.service.js';
import { VoicePresenceService } from '../dist/modules/voice/voice-presence.service.js';
import { invalidateOperatorCache } from '../dist/modules/voice/operator-config.js';
import { missionAnnouncementText, sessionAnnouncementText } from '../dist/modules/voice/announcement-text.js';

process.env.ENCRYPTION_KEY ??= 'voice-announcer-test-key';

const TTS_READY = {
  'voice.tts.provider': 'openai',
  'voice.openai.api_key': 'sk-test',
  'voice.stt.languages': 'ko,en',
};

function setup(settings = TTS_READY, { missions = {}, steps = {}, owners = [] } = {}) {
  const rows = Object.entries(settings).map(([key, value]) => ({
    key, value: key.endsWith('.api_key') && value ? encrypt(value) : value,
  }));
  const repos = {
    // operator 가 없는 사이트 — 세션 소식은 예전처럼 템플릿으로 직접 알린다(작업 보고는 voice-operator-reports.test.mjs).
    SystemSetting: { find: async () => rows, findOne: async () => null },
    OrchestrationMission: { findOne: async ({ where }) => missions[where.id] ?? null },
    OrchestrationStep: { findOne: async ({ where }) => steps[`${where.mission_id}/${where.step_key}`] ?? null },
  };
  const dataSource = { getRepository: (name) => repos[name] };
  const log = { warn() {}, error() {}, info() {}, debug() {} };
  invalidateVoiceConfig();
  const voice = new VoiceService(dataSource, log);
  const synthCalls = [];
  voice.fetchImpl = async (url, init) => {
    synthCalls.push(JSON.parse(init.body));
    return new Response(Buffer.from('mp3'), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  };
  const rebac = { listSubjects: async () => owners };
  invalidateOperatorCache();
  const reports = new OperatorReportService(dataSource, { promptOnBehalf: async () => { throw new Error('no operator to prompt'); } }, log);
  const announcer = new VoiceAnnouncerService(dataSource, voice, log, rebac, reports, new VoicePresenceService());
  announcer.onModuleInit();
  const heard = [];
  const onAnnounce = (p) => heard.push(p);
  activityEvents.on('voice_announcement', onAnnounce);
  const teardown = () => {
    announcer.onModuleDestroy();
    activityEvents.removeListener('voice_announcement', onAnnounce);
  };
  return { announcer, heard, synthCalls, teardown };
}

const flush = () => new Promise((r) => setTimeout(r, 20));
const session = (over = {}) => ({
  manager_id: 'host-1', manager_name: 'rolf', cli: 'claude', session_id: 's1', title: '배포 정리',
  status: 'ready', driver_user_id: 'u1', ...over,
});
const update = (reason, over = {}) => activityEvents.emit('agent_session_update', {
  session: session(over), reason, driver_user_id: 'u1', timestamp: new Date().toISOString(),
});
const event = (type, payload, turn_id = 't1') => activityEvents.emit('agent_session_event', {
  manager_id: 'host-1', cli: 'claude', session_id: 's1', driver_user_id: 'u1',
  event: { id: `${type}-${Math.random()}`, seq: 0, turn_id, type, payload, created_at: new Date().toISOString() },
});

test('a finished turn is announced to its driver with the first lines of the answer', async (t) => {
  const { heard, teardown } = setup();
  t.after(teardown);
  // 시작을 못 본 턴(서버가 턴 도중 재시작) — 길었다고 본다.
  event('text', { text: '확인해 볼게요.' });
  event('tool_call', { tool_call_id: 'x' });
  event('text', { text: '## 결과\n배포가 끝났고 **테스트 280개**가 모두 통과했어요.\n```sh\nnpm test\n```' });
  event('turn', { phase: 'finished', stop_reason: 'end_turn' });
  update('turn_finished');
  await flush();
  assert.equal(heard.length, 1);
  assert.equal(heard[0].user_id, 'u1');
  assert.equal(heard[0].kind, 'session_turn_finished');
  assert.equal(heard[0].text, "rolf의 Claude Code 세션 '배포 정리' 작업이 끝났어요. 결과. 배포가 끝났고 테스트 280개가 모두 통과했어요.");
  assert.deepEqual(heard[0].target, { type: 'session', manager_id: 'host-1', cli: 'claude', session_id: 's1' });
});

test('short and cancelled turns are not announced; failures are', async (t) => {
  const { heard, teardown } = setup();
  t.after(teardown);
  update('turn_started', { status: 'busy' });
  event('text', { text: '네.' }, 't2');
  event('turn', { phase: 'finished' }, 't2');
  update('turn_finished');
  await flush();
  assert.equal(heard.length, 0, 'a quick answer is not worth announcing');

  event('text', { text: '중간까지' }, 't3');
  event('turn', { phase: 'finished', stop_reason: 'cancelled' }, 't3');
  update('turn_finished');
  await flush();
  assert.equal(heard.length, 0, 'the user stopped it');

  update('turn_started', { status: 'busy' });
  event('turn', { phase: 'finished', stop_reason: 'error' }, 't4');
  update('turn_failed', { status: 'error' });
  await flush();
  assert.equal(heard.length, 1);
  assert.equal(heard[0].kind, 'session_turn_failed');
  assert.equal(heard[0].text, "rolf의 Claude Code 세션 '배포 정리'에서 오류가 났어요.");
});

test('waiting for the user is announced once per burst', async (t) => {
  const { heard, teardown } = setup();
  t.after(teardown);
  update('permission', { status: 'awaiting_permission' });
  update('permission', { status: 'awaiting_permission' });
  update('elicitation', { status: 'awaiting_input' });
  await flush();
  assert.equal(heard.length, 1);
  assert.equal(heard[0].kind, 'session_needs_input');
  assert.match(heard[0].text, /확인을 기다리고 있어요\.$/);
});

test('missions: terminal and decision events only, to the human owner or else the workspace owners', async (t) => {
  const missions = {
    m1: { id: 'm1', workspace_id: 'w1', title: '음성 게이트웨이', created_by_type: 'user', created_by: 'u7', result_summary: '세 단계 모두 끝났고 PR #23 을 열었어요.' },
    m2: { id: 'm2', workspace_id: 'w1', title: '야간 점검', created_by_type: 'agent', created_by: 'agent-1', result_summary: '' },
  };
  const steps = { 'm2/approve': { title: '배포 승인' } };
  const { heard, teardown } = setup(TTS_READY, { missions, steps, owners: [{ type: 'user', id: 'owner-1' }, { type: 'agent', id: 'x' }] });
  t.after(teardown);
  const missionUpdate = (mission_id, type, extra = {}) => activityEvents.emit('orchestration_update', {
    mission_id, workspace_id: 'w1', title: missions[mission_id].title, status: 'running',
    counts: { total: 3, done: 3, failed: 0 }, last_event: { type, message: '', step_key: extra.step_key || '' },
  });
  missionUpdate('m1', 'step_completed');
  missionUpdate('m1', 'mission_completed');
  missionUpdate('m2', 'confirm_notified', { step_key: 'approve' });
  await flush();
  assert.equal(heard.length, 2, 'step progress is not announced');
  assert.equal(heard[0].user_id, 'u7');
  assert.equal(heard[0].text, "'음성 게이트웨이' 미션이 끝났어요. 단계 3개 중 3개가 끝났어요. 세 단계 모두 끝났고 PR #23 을 열었어요.");
  assert.deepEqual(heard[0].target, { type: 'mission', workspace_id: 'w1', mission_id: 'm1' });
  assert.equal(heard[1].user_id, 'owner-1', 'agent-created mission → workspace owners (users only)');
  assert.equal(heard[1].text, "'야간 점검' 미션에서 결정이 필요해요. 단계: 배포 승인.");
});

test('work update cues are announced even when text-to-speech is not ready', async (t) => {
  const { heard, teardown } = setup({ 'voice.tts.provider': 'elevenlabs' }); // 키도 목소리도 없음
  t.after(teardown);
  update('turn_failed', { status: 'error' });
  await flush();
  assert.equal(heard.length, 1);
  assert.equal(heard[0].kind, 'session_turn_failed');
});

test('announcement audio: only its recipient, synthesised once', async (t) => {
  const { announcer, heard, synthCalls, teardown } = setup();
  t.after(teardown);
  update('turn_failed', { status: 'error' });
  await flush();
  const [a] = heard;
  await assert.rejects(() => announcer.audio(a.id, 'someone-else'), (e) => e.status === 404);
  const first = await announcer.audio(a.id, 'u1');
  const second = await announcer.audio(a.id, 'u1');
  assert.equal(first.contentType, 'audio/mpeg');
  assert.ok(second.audio.equals(first.audio));
  assert.equal(synthCalls.length, 1);
  assert.equal(synthCalls[0].input, a.text);
  await assert.rejects(() => announcer.audio('nope', 'u1'), (e) => e.status === 404);
});

test('English templates follow the configured language and keep counts honest', () => {
  assert.equal(
    sessionAnnouncementText('session_needs_input', { hostName: 'rolf', cliLabel: 'Codex', title: '' }, 'en'),
    'The Codex session on rolf is waiting for you.',
  );
  assert.equal(
    missionAnnouncementText('mission_failed', { title: 'Nightly', counts: { failed: 1 }, summary: null }, 'en'),
    'Mission "Nightly" failed. 1 step failed.',
  );
  assert.equal(
    missionAnnouncementText('mission_failed', { title: '야간', counts: { failed: 2 }, summary: 'orchestrator declared the mission failed' }, 'ko'),
    "'야간' 미션이 실패했어요. 실패한 단계가 2개 있어요. orchestrator declared the mission failed.",
  );
});
