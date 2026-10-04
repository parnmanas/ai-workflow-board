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
  isViewingTarget,
  sessionTargetKey,
  setViewingSession,
  tryClaim, shouldSpeakAnnouncement } from '../src/voice/announcements.ts';

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
  assert.equal(isViewingTarget({ type: 'mission', workspace_id: 'w', mission_id: 'm' }, true), false);
  setViewingSession(null);
  assert.equal(isViewingTarget(target, true), false);
});

test('announcement links: missions carry their workspace, sessions use the current one', () => {
  assert.equal(announcementPath({ type: 'mission', workspace_id: 'w9', mission_id: 'mm' }, 'w1'), '/ws/w9/orchestration/missions/mm');
  assert.equal(announcementPath({ type: 'session', manager_id: 'm1', cli: 'claude', session_id: 's1' }, 'w1'), '/ws/w1/sessions/m1/claude/s1');
  assert.equal(announcementPath({ type: 'session', manager_id: 'm1', cli: 'claude', session_id: 's1' }, null), null);
  assert.equal(announcementPath(null, 'w1'), null);
});

test('an announcement about the session on screen is not spoken — unless it awaits a decision', () => {
  assert.equal(shouldSpeakAnnouncement(false, false), true);
  assert.equal(shouldSpeakAnnouncement(true, false), false, 'the screen already shows it');
  assert.equal(shouldSpeakAnnouncement(true, true), true, 'choices are read so the user can answer by voice');
});
