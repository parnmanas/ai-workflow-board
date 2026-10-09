// 음성 지원 스위치(사이드바 OPERATORS 의 👂) → 서버 — docs/voice-operator.md "음성 지원 · 잠들기".
// 스위치는 단말마다 따로라 화면이 이 단말의 고정 id 와 함께 켜짐/꺼짐을 서버에 알린다. 서버는 사용자의 단말이
// 모두 꺼져 있으면 세션 완료를 operator 에게 보고하지 않는다(서버 test/voice-support-switch.test.mjs).
import assert from 'node:assert/strict';
import test from 'node:test';
import { setupDom } from './helpers/jsdom.mjs';
import { api } from '../src/api.ts';
import { wakeStore } from '../src/voice/wakeState.ts';
import { voiceDeviceId } from '../src/voice/presence.ts';

test('flipping the switch tells the server, with a device id that stays the same', async (t) => {
  const dom = setupDom();
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = window.localStorage;
  t.after(() => { globalThis.localStorage = previousStorage; dom.cleanup(); });
  const sent = t.mock.method(api, 'reportVoiceSupport', async () => ({ operator_reports: false }));
  wakeStore.setEnabled(false);
  wakeStore.setEnabled(true);
  wakeStore.setEnabled(false);
  assert.deepEqual(sent.mock.calls.map((c) => c.arguments[0].enabled), [false, true, false]);
  const ids = new Set(sent.mock.calls.map((c) => c.arguments[0].device_id));
  assert.equal(ids.size, 1, 'one device, one id');
  assert.equal([...ids][0], voiceDeviceId(), 'the id persists in this browser');
  assert.ok(voiceDeviceId().length >= 8);
});

test('the toggle explains that off also stops session reports to the operator', async () => {
  const { describeWake } = await import('../src/voice/WakeToggle.tsx');
  const text = describeWake({ enabled: false, mode: 'off', operatorId: null, listener: 'idle', micClaims: 0, followUp: null }, [], null, null);
  assert.match(text, /세션 완료 소식도 operator 에게 가지 않습니다/);
});
