// 음성 알림의 화면 쪽 규칙 회귀 테스트(docs/voice-operator.md "음성 알림").
// 실행: node --import tsx --test apps/client/test/voice-announcements.test.mjs
//
// 고정하는 것:
//   1. 한 번만 말한다 — 같은 알림을 여러 탭이 집으면 처음 하나만 이긴다.
//   2. 집은 표시는 쌓이지 않는다 — 하루 지난 표시는 다음 집기 때 치운다.
//   3. 보고 있는(visible) 그 세션을 가리키는 알림만 "보고 있음" 이다 — 숨은 탭이나 다른 세션은 아니다.
//   4. 알림을 누르면 가는 곳: 미션은 그 워크스페이스, 세션은 지금 워크스페이스 아래.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  announcementPath,
  announcementPlayback,
  isViewingTarget,
  sessionTargetKey,
  setViewingSession,
  shouldSpeakAnnouncement,
  tryClaim,
} from '../src/voice/announcements.ts';
import { NOTIFICATION_SOUNDS, isNotificationSound, notificationSoundClip } from '../src/voice/notificationSound.ts';

test('work reports cue first; only the conversational operator response is spoken', () => {
  for (const kind of ['operator_report', 'session_turn_finished', 'session_turn_failed', 'session_needs_input', 'mission_completed', 'mission_needs_decision']) {
    assert.equal(announcementPlayback(kind), 'cue', kind);
  }
  assert.equal(announcementPlayback('operator_reply'), 'speech');
});

test('each selectable cue is a short, audible WAV without an engine', async () => {
  const clips = [];
  for (const sound of NOTIFICATION_SOUNDS) {
    assert.equal(isNotificationSound(sound.value), true);
    const clip = notificationSoundClip(sound.value);
    assert.equal(clip.type, 'audio/wav');
    const bytes = Buffer.from(await clip.arrayBuffer());
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
    assert.equal(bytes.readUInt32LE(40), bytes.length - 44);
    assert.equal(bytes.readUInt16LE(22), 1);
    assert.ok((bytes.length - 44) / bytes.readUInt32LE(28) < 1, 'less than a second');
    assert.ok(bytes.subarray(44).some((n) => n !== 0), 'audible samples');
    clips.push(bytes.toString('base64'));
  }
  assert.equal(new Set(clips).size, NOTIFICATION_SOUNDS.length);
  assert.equal(isNotificationSound('corrupt-setting'), false);
});

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    keys: () => [...map.keys()],
  };
}

test('only the first claimer of an announcement wins', () => {
  const storage = memoryStorage();
  assert.equal(tryClaim('a1', storage, 1000), true);
  assert.equal(tryClaim('a1', storage, 1001), false);
  assert.equal(tryClaim('a2', storage, 1002), true);
});

test('day-old claim markers are cleaned up; other keys are left alone', () => {
  const day = 24 * 60 * 60 * 1000;
  const storage = memoryStorage({
    'awb.voice.claimed.old': '0',
    'awb.voice.claimed.recent': String(day),
    'awb.voice.readReplies': '1',
  });
  tryClaim('new', storage, day + 10);
  assert.deepEqual(storage.keys().sort(), ['awb.voice.claimed.new', 'awb.voice.claimed.recent', 'awb.voice.readReplies']);
});

test('viewing means: this exact session, in a visible tab', () => {
  const target = { type: 'session', manager_id: 'm1', cli: 'claude', session_id: 's1' };
  setViewingSession(sessionTargetKey('m1', 'claude', 's1'));
  assert.equal(isViewingTarget(target, true), true);
  assert.equal(isViewingTarget(target, false), false, 'a hidden tab is not looking');
  assert.equal(isViewingTarget({ ...target, session_id: 's2' }, true), false);
  assert.equal(isViewingTarget({ type: 'mission', account_id: 'w', mission_id: 'm' }, true), false);
  setViewingSession(null);
  assert.equal(isViewingTarget(target, true), false);
});

test('announcement links address work directly without an ownership account', () => {
  assert.equal(announcementPath({ type: 'mission', account_id: 'w9', mission_id: 'mm' }, 'w1'), '/missions/mm');
  assert.equal(announcementPath({ type: 'session', manager_id: 'm1', cli: 'claude', session_id: 's1' }, 'w1'), '/sessions/m1/claude/s1');
  assert.equal(announcementPath({ type: 'session', manager_id: 'm1', cli: 'claude', session_id: 's1' }, null), '/sessions/m1/claude/s1');
  assert.equal(announcementPath(null, 'w1'), null);
});

test('a viewed session stays quiet unless it awaits a decision cue', () => {
  assert.equal(shouldSpeakAnnouncement(false, false), true);
  assert.equal(shouldSpeakAnnouncement(true, false), false, 'the screen already shows it');
  assert.equal(shouldSpeakAnnouncement(true, true), true, 'a cue invites a request for details and choices');
});

test('a work/question SSE focuses the operator and starts its composer before any speech or cue completion', async (t) => {
  const { setupDom, React, act, assertFocused } = await import('./helpers/jsdom.mjs');
  const { installFakeEventSource, mountWithBoardStream } = await import('./helpers/boardStream.mjs');
  const { MemoryRouter, useLocation } = await import('react-router-dom');
  const { NotificationProvider } = await import('../src/contexts/NotificationContext.tsx');
  const { api } = await import('../src/api.ts');
  const { speechPlayer } = await import('../src/voice/speechPlayer.ts');
  const { loadVoiceConfig } = await import('../src/voice/useVoice.ts');
  const { setNotificationPref, getNotificationPrefs } = await import('../src/contexts/notificationPrefs.ts');
  const { wakeStore, useWakeState } = await import('../src/voice/wakeState.ts');
  const { default: SessionComposer } = await import('../src/components/sessions/SessionComposer.tsx');
  const { default: VoiceAnnouncer } = await import('../src/voice/VoiceAnnouncer.tsx');
  const { default: WakeListener } = await import('../src/voice/WakeListener.tsx');
  const dom = setupDom();
  const { MicVAD } = await import('@ricky0123/vad-web');
  const originalVadNew = MicVAD.new;
  const originalAudioContext = globalThis.AudioContext;
  globalThis.AudioContext = class {
    state = 'running';
    async close() { this.state = 'closed'; }
  };
  const previousMedia = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  window.MediaRecorder = class {};
  let microphoneStarts = 0;
  let vadOptions;
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    getUserMedia: async () => { microphoneStarts++; return { getTracks: () => [] }; },
  } });
  MicVAD.new = async (options) => {
    vadOptions = options;
    await options.getStream();
    return { start: async () => {}, pause: async () => {}, destroy: async () => {} };
  };
  const { FakeEventSource, uninstall } = installFakeEventSource();
  globalThis.localStorage = dom.window.localStorage;
  localStorage.setItem('auth_token', 'test-token');
  const previousPrefs = { ...getNotificationPrefs() };
  setNotificationPref('voice', true); setNotificationPref('audio', true); setNotificationPref('workSound', 'bell');
  setNotificationPref('listenAfterWorkSound', true);
  wakeStore.setEnabled(false);
  const originals = { getMe: api.getMe, getSetupStatus: api.getSetupStatus, getVoiceConfig: api.getVoiceConfig,
    getUnreadMentions: api.getUnreadMentions, getChatUnreadCounts: api.getChatUnreadCounts, getTicketUnreadCounts: api.getTicketUnreadCounts,
    getVoiceAnnouncementAudio: api.getVoiceAnnouncementAudio, enqueueClip: speechPlayer.enqueueClip,
    listVoiceOperators: api.listVoiceOperators, transcribeVoice: api.transcribeVoice };
  let ttsCalls = 0;
  const queued = [];
  api.getMe = async () => ({ id: 'u1', name: 'User', role: 'user', status: 'active', permissions: ['voice.use'], accounts: [{ id: 'w1', name: 'Work', slug: null, relations: [] }] });
  api.getSetupStatus = async () => ({ needs_setup: false });
  api.getVoiceConfig = async () => ({ stt: { provider: 'local', ready: true }, tts: { provider: 'none', ready: false }, wake: { ready: true } });
  api.getUnreadMentions = async () => ({ count: 0, items: [] });
  api.getChatUnreadCounts = async () => ({ total: 0, perRoom: {} });
  api.getTicketUnreadCounts = async () => ({ total: 0, perTicket: {} });
  api.getVoiceAnnouncementAudio = async () => { ttsCalls++; throw new Error('work reports must not call TTS'); };
  api.listVoiceOperators = async () => ({ operators: [{ id: 'op', name: 'Jarvis', aliases: [], manager_id: 'm1', cli: 'codex', session_id: 'operator-session' }] });
  const purposes = [];
  const prompts = [];
  api.transcribeVoice = async (_wav, purpose) => { purposes.push(purpose); return { text: '보고해' }; };
  speechPlayer.enqueueClip = (fetchClip, key, onEnded) => queued.push({ fetchClip, key, onEnded });
  await loadVoiceConfig(true);
  const h = React.createElement;
  let currentPath;
  function RouteProbe() {
    currentPath = useLocation().pathname;
    const wake = useWakeState();
    const here = currentPath === '/sessions/m1/codex/operator-session';
    React.useEffect(() => here ? wakeStore.attach('op') : undefined, [here]);
    return here ? h(SessionComposer, { disabled: false, busy: false, placeholder: 'Operator prompt',
      onSend: (prompt) => prompts.push(prompt), onCancel: () => {},
      voiceInput: { liveCaptions: false, wake: { name: 'Jarvis', awake: wake.mode === 'awake' && wake.operatorId === 'op',
        activationKey: wake.wokeAt, takeFirstPrompt: () => wakeStore.takeFirstPrompt('op'),
        transformUtterance: (text) => text, onSleep: () => wakeStore.sleep('op') } },
    }) : null;
  }
  const view = mountWithBoardStream(h(NotificationProvider, null, h(React.Fragment, null,
    h(VoiceAnnouncer), h(WakeListener), h(RouteProbe))), { wrap: (tree) => h(MemoryRouter, null, tree) });
  t.after(() => {
    setViewingSession(null);
    act(() => { wakeStore.setEnabled(false); view.unmount(); });
    uninstall(); dom.cleanup();
    MicVAD.new = originalVadNew;
    globalThis.AudioContext = originalAudioContext;
    if (previousMedia) Object.defineProperty(navigator, 'mediaDevices', previousMedia);
    else delete navigator.mediaDevices;
    for (const [key, value] of Object.entries(originals)) { if (key === 'enqueueClip') speechPlayer[key] = value; else api[key] = value; }
    for (const [key, value] of Object.entries(previousPrefs)) setNotificationPref(key, value);
  });
  const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
  await flush();
  const source = FakeEventSource.instances[0];
  assert.ok(source, 'an authenticated SSE connection must exist');
  const event = { id: 'report-new', user_id: 'u1', kind: 'operator_report', text: 'Work finished',
    operator: { id: 'op', name: 'Jarvis' }, target: { type: 'session', manager_id: 'm1', cli: 'codex', session_id: 's1' }, needs_decision: true };
  act(() => source.emit('voice_announcement', event));
  await flush();
  assert.equal(queued.length, 1, 'work cues also work with TTS off');
  assert.equal(wakeStore.state.followUp, null, 'the actual composer replaces background notification input');
  assert.equal(wakeStore.state.enabled, false, 'do not enable persistent name calling');
  assert.equal(wakeStore.state.mode, 'awake');
  assert.equal(wakeStore.state.operatorId, 'op');
  assert.equal(currentPath, '/sessions/m1/codex/operator-session', 'open the operator, not the source session');
  assert.equal(microphoneStarts, 1, 'open the actual composer without waiting for cue completion');
  assertFocused(view.container.querySelector('textarea'), 'focus the operator input before speaking');
  assert.deepEqual(prompts, [], 'opening input must not fabricate a user request or answer');
  const actual = Buffer.from(await (await queued[0].fetchClip()).arrayBuffer());
  const expected = Buffer.from(await notificationSoundClip('bell').arrayBuffer());
  assert.deepEqual(actual, expected);
  assert.equal(ttsCalls, 0);
  act(() => { vadOptions.onSpeechStart(); vadOptions.onSpeechEnd(new Float32Array(16000)); });
  await flush();
  assert.deepEqual(prompts.map((prompt) => [prompt.text, prompt.spoken]), [['보고해', true]]);
  assert.deepEqual(purposes, [undefined], 'direct operator input uses utterance STT');
  act(() => wakeStore.setEnabled(false));
  await flush();
  act(() => source.emit('voice_announcement', event));
  await flush();
  assert.equal(queued.length, 1, 'the same SSE is claimed once');
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  setViewingSession(sessionTargetKey('m1', 'codex', 's1'));
  act(() => source.emit('voice_announcement', { ...event, id: 'viewed-completion', needs_decision: false }));
  await flush();
  assert.equal(queued.length, 1, 'ordinary viewed updates stay quiet');
  act(() => source.emit('voice_announcement', { ...event, id: 'viewed-question' }));
  await flush();
  assert.equal(queued.length, 2, 'viewed decisions still cue without reading choices');
  assert.equal(ttsCalls, 0);
  assert.equal(wakeStore.state.mode, 'awake', 'questions also open the operator composer immediately');
  assert.equal(wakeStore.state.source, 'notification');
  assertFocused(view.container.querySelector('textarea'));
  act(() => setNotificationPref('listenAfterWorkSound', false));
  await flush();
  assert.equal(wakeStore.state.mode, 'off', 'turning the option off closes automatically opened input');
  assert.equal(wakeStore.state.micClaims, 0);
  act(() => source.emit('voice_announcement', { ...event, id: 'opted-out-question' }));
  await flush();
  assert.equal(queued.length, 3, 'the cue remains enabled when automatic microphone input is off');
  assert.equal(wakeStore.state.mode, 'off');
  assert.equal(prompts.length, 1);
  act(() => source.emit('voice_announcement', { ...event, id: 'reply-with-tts-off', kind: 'operator_reply' }));
  await flush();
  assert.equal(queued.length, 3, 'conversation replies still require TTS');

  // The user may enable name calling after the short input window has closed.
  act(() => source.emit('voice_announcement', { ...event, id: 'manual-report' }));
  await flush();
  assert.equal(wakeStore.reportOperator(), 'op');
  act(() => wakeStore.setEnabled(true));
  await flush();
  assert.equal(wakeStore.state.followUp, null);
  const speech = () => { vadOptions.onSpeechStart(); vadOptions.onSpeechEnd(new Float32Array(16000)); };
  api.transcribeVoice = async () => ({ text: '', ignored: 'speaker_mismatch' });
  act(speech); await flush();
  assert.equal(wakeStore.state.listener, 'error');
  assert.match(wakeStore.state.error, /등록한 내 목소리/);
  api.transcribeVoice = async () => ({ text: '커피' });
  act(speech); await flush();
  assert.equal(wakeStore.state.mode, 'sleeping', 'unrelated speech does not address a stale notification');
  api.transcribeVoice = async () => ({ text: '보고해' });
  act(speech); await flush();
  assert.equal(wakeStore.state.mode, 'awake', 'manually enabling the microphone still accepts 보고해');
  assert.equal(prompts.at(-1).text, '보고해', 'manual name calling still delivers the request once');
  assert.equal(currentPath, '/sessions/m1/codex/operator-session');
});

test('audio completion callbacks run after successful playback, never after interruption or failure', async (t) => {
  const { speechPlayer } = await import('../src/voice/speechPlayer.ts');
  const originalAudio = globalThis.Audio;
  let audio;
  let blocked = false;
  class TestAudio {
    constructor() { audio = this; }
    play() { return blocked ? Promise.reject(new Error('blocked')) : Promise.resolve(); }
    pause() {}
    load() {}
    removeAttribute() {}
  }
  globalThis.Audio = TestAudio;
  t.after(() => { speechPlayer.stop(); globalThis.Audio = originalAudio; });
  const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); };
  let completed = 0;
  const clip = async () => notificationSoundClip('chime');
  speechPlayer.enqueueClip(clip, 'cue-success', () => completed++);
  await flush();
  assert.equal(completed, 0, 'fetching or starting audio cannot open the microphone');
  audio.onended();
  await flush();
  assert.equal(completed, 1);
  speechPlayer.enqueueClip(clip, 'cue-interrupted', () => completed++);
  speechPlayer.enqueueClip(clip, 'cue-cancelled-in-queue', () => completed++);
  await flush();
  speechPlayer.stop();
  await flush();
  assert.equal(completed, 1, 'interrupted and discarded cues do not enable input');
  blocked = true;
  speechPlayer.enqueueClip(clip, 'cue-blocked', () => completed++);
  await flush();
  assert.equal(completed, 1, 'playback failure cannot enable input');
  assert.equal(speechPlayer.state.error, 'blocked');
});
