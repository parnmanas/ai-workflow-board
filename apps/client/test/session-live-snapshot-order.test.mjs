// 세션 상태 badge 가 양방향으로 어긋났던 버그 — "대화는 끝났는데 working",
// "돌고 있는데 ready" (실측 2026-10-01).
//
// 원인은 상태가 지연이 서로 다른 **세 경로**로 들어오는데 순서 보장이 없던 것:
//   SSE 패치(즉시) · 하트비트 스냅샷(30초 주기) · RPC 응답(history/open/prompt, 최대 120초).
// 클라이언트의 `setLive(...)` 7곳이 전부 무조건 덮어써서, 느린 RPC 응답이 **더 최신인
// SSE 패치를 과거 상태로 되돌렸다.** 서버의 재조정은 edge-triggered 라("보고된 상태 ==
// 내 상태면 그냥 반환") 한 번 틀어지면 교정 SSE 가 오지 않아 그대로 고착된다.
// 스냅샷은 이미 `updated_at` 을 싣고 있었다 — 비교하는 쪽이 없었을 뿐이다.
//
// 특히 아팠던 이유: busy 에 고착되면 컴포저가 입력한 프롬프트를 전송하지 않고 조용히
// 큐에 쌓는다. 그래서 "안 보내진다" 가 상태 버그의 2차 증상으로 나타났다.
// 실행: node --import tsx --test apps/client/test/session-live-snapshot-order.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeLiveSnapshot } from '../src/components/sessions/sessionTranscript.logic.ts';

const snap = (over = {}) => ({
  manager_id: 'm-rolf',
  manager_name: 'rolf',
  cli: 'claude',
  session_id: 's-1',
  cwd: '/srv/app',
  title: 't',
  status: 'idle',
  current_mode: null,
  available_modes: [],
  config_options: [],
  available_commands: [],
  resume_supported: true,
  auth: null,
  last_error: null,
  driver_user_id: 'u-1',
  updated_at: '2026-10-01T00:00:10.000Z',
  ...over,
});

test('더 과거의 스냅샷은 버린다 — 느린 RPC 응답이 최신 SSE 패치를 되돌리지 못한다', () => {
  const live = snap({ status: 'busy', updated_at: '2026-10-01T00:00:20.000Z' });
  const staleRpc = snap({ status: 'ready', updated_at: '2026-10-01T00:00:10.000Z' });
  assert.equal(mergeLiveSnapshot(live, staleRpc).status, 'busy', '돌고 있는데 ready 로 되돌리면 안 된다');
  assert.equal(mergeLiveSnapshot(live, staleRpc), live, '같은 객체를 그대로 유지한다(불필요한 리렌더 방지)');
});

test('더 최신 스냅샷은 채택한다 — 멈춰 버리면 그게 더 나쁘다', () => {
  const live = snap({ status: 'busy', updated_at: '2026-10-01T00:00:10.000Z' });
  const fresh = snap({ status: 'ready', updated_at: '2026-10-01T00:00:20.000Z' });
  assert.equal(mergeLiveSnapshot(live, fresh).status, 'ready', '대화가 끝났으면 working 에서 내려와야 한다');
});

test('같은 시각이면 채택한다 — 동률에서 과거를 고집할 근거가 없다', () => {
  const live = snap({ status: 'busy' });
  const same = snap({ status: 'ready' });
  assert.equal(mergeLiveSnapshot(live, same).status, 'ready');
});

test('다른 세션의 스냅샷은 시각 비교 없이 교체한다 — 세션 전환은 시간 역행이 아니다', () => {
  const live = snap({ session_id: 's-1', updated_at: '2026-10-01T00:05:00.000Z' });
  for (const other of [
    snap({ session_id: 's-2', updated_at: '2026-10-01T00:00:01.000Z' }),
    snap({ cli: 'codex', updated_at: '2026-10-01T00:00:01.000Z' }),
    snap({ manager_id: 'm-ralf', updated_at: '2026-10-01T00:00:01.000Z' }),
  ]) {
    assert.equal(mergeLiveSnapshot(live, other), other, '다른 세션이면 더 오래된 시각이어도 채택한다');
  }
});

test('null 은 명시적 초기화로 존중하고, 들고 있는 것이 없으면 그대로 채택한다', () => {
  assert.equal(mergeLiveSnapshot(snap(), null), null);
  const first = snap();
  assert.equal(mergeLiveSnapshot(null, first), first);
});

test('시각을 파싱할 수 없으면 채택한다 — 순서를 모를 때 멈춰 있는 편이 더 위험하다', () => {
  const live = snap({ status: 'busy', updated_at: '2026-10-01T00:00:20.000Z' });
  assert.equal(mergeLiveSnapshot(live, snap({ status: 'ready', updated_at: 'nonsense' })).status, 'ready');
  assert.equal(
    mergeLiveSnapshot(snap({ status: 'busy', updated_at: '' }), snap({ status: 'ready' })).status,
    'ready',
  );
});
