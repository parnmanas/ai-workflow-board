// 챗룸 keep-alive/백그라운드 작업 배지 회귀 테스트 (티켓 e18be8ff 리뷰 라운드1).
//
// 리뷰어가 지적한 두 가지 P1을 이 테스트가 커버한다:
//  1. 만료된 keep-alive 배지가 "잔여 0분"으로 영구 잔류 — 30초 tick에서
//     deadline이 지나고 background task가 0인 항목을 제거해야 한다.
//  2. 새로고침·방 재진입 시 이미 활성인 세션 상태를 복원할 수 없음 — GET
//     session-status 스냅샷 응답을 sessionStatusByAgent로 정확히 매핑해야 한다.
//
// participantFlow.ts 테스트와 같은 방식으로, ChatPage.tsx 가 실제로 import 하는
// sessionStatusFlow.ts 를 그대로 구동한다(미러 아님) — 순수 함수라 React/jsdom 불필요.
//
// 실행:  node --import tsx --test apps/client/test/chat-session-status-badge.test.mjs
//   또는 npm test -w client   (레포 루트에서)

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isSessionStatusLive,
  pruneExpiredSessionStatus,
  restoreSessionStatusSnapshot,
  mergeSessionStatusSnapshot,
} from '../src/components/chat/utils/sessionStatusFlow.ts';

test('pruneExpiredSessionStatus removes an expired keep-alive entry with no live background tasks', () => {
  const now = 1_000_000;
  const prev = {
    agentA: { name: 'A', keepAliveUntilMs: now - 1, backgroundTaskCount: 0 }, // expired
    agentB: { name: 'B', keepAliveUntilMs: now + 60_000, backgroundTaskCount: 0 }, // still active
  };
  const next = pruneExpiredSessionStatus(prev, now);
  assert.deepEqual(Object.keys(next), ['agentB']);
  assert.equal(next.agentB, prev.agentB);
});

test('pruneExpiredSessionStatus keeps an entry past its deadline while background tasks are still live', () => {
  const now = 1_000_000;
  const prev = {
    agentA: { name: 'A', keepAliveUntilMs: now - 1, backgroundTaskCount: 2 },
  };
  const next = pruneExpiredSessionStatus(prev, now);
  assert.deepEqual(next, prev);
});

test('pruneExpiredSessionStatus returns the same reference when nothing expired (avoids extra re-render)', () => {
  const now = 1_000_000;
  const prev = {
    agentA: { name: 'A', keepAliveUntilMs: now + 60_000, backgroundTaskCount: 0 },
  };
  const next = pruneExpiredSessionStatus(prev, now);
  assert.equal(next, prev);
});

test('pruneExpiredSessionStatus with a null deadline and no background tasks is dropped as not-live', () => {
  const now = 1_000_000;
  const prev = {
    agentA: { name: 'A', keepAliveUntilMs: null, backgroundTaskCount: 0 },
  };
  const next = pruneExpiredSessionStatus(prev, now);
  assert.deepEqual(next, {});
});

test('isSessionStatusLive treats an exactly-expired deadline (== now) as not live', () => {
  const now = 1_000_000;
  assert.equal(isSessionStatusLive({ name: 'A', keepAliveUntilMs: now, backgroundTaskCount: 0 }, now), false);
});

test('restoreSessionStatusSnapshot maps a GET session-status snapshot into room state on room entry', () => {
  const rows = [
    { agent_id: 'agentA', agent_name: 'Rolf/AWB.Programmer', keep_alive_until_ms: 5_000, background_task_count: 3 },
    { agent_id: 'agentB', agent_name: '', keep_alive_until_ms: null, background_task_count: 0 },
  ];
  const restored = restoreSessionStatusSnapshot(rows);
  assert.deepEqual(restored, {
    agentA: { name: 'Rolf/AWB.Programmer', keepAliveUntilMs: 5_000, backgroundTaskCount: 3 },
    agentB: { name: 'Agent', keepAliveUntilMs: null, backgroundTaskCount: 0 },
  });
});

test('restoreSessionStatusSnapshot on an empty snapshot (no live sessions) clears any stale local state', () => {
  const restored = restoreSessionStatusSnapshot([]);
  assert.deepEqual(restored, {});
});

// Regression for ticket e18be8ff review round 2, P1 #2 — "방 진입 중 GET 스냅샷
// 응답이 더 최신 SSE 상태를 덮어쓸 수 있습니다." The room-entry GET above is a
// snapshot read that races the live chat_room_session_status SSE push: GET
// can read stale state, a newer SSE frame can land before the GET response
// does, and a plain `setSessionStatusByAgent(restoreSessionStatusSnapshot(...))`
// replace would then stomp the newer SSE-derived state back to the stale
// snapshot. mergeSessionStatusSnapshot is what ChatPage.tsx now calls instead.
//
// Review round 2 follow-up, P1 #2: the caller originally stamped both sides
// of this race with `Date.now()`. Millisecond resolution means a GET issued
// and an SSE frame handled in the same tick produce EQUAL timestamps, and
// `updatedAt <= requestStartedAt` then classifies that same-tick SSE as
// "not newer" — the exact bug this guard exists to prevent. ChatPage.tsx now
// stamps both sides with a shared monotonic counter instead (see
// `sessionStatusSeqRef`/`nextSessionStatusSeq` there), so the values below
// are sequence numbers, not epoch ms — but mergeSessionStatusSnapshot's
// contract is unchanged: it just compares whatever ordinal it's handed.

test('mergeSessionStatusSnapshot keeps a newer SSE-added entry the GET snapshot predates', () => {
  const requestStartedSeq = 1_000_000;
  // SSE granted agentA a keep-alive AFTER the GET request began reading, so
  // the snapshot it read back (rows) never saw it.
  const prev = {
    agentA: { name: 'A', keepAliveUntilMs: 1_010_000, backgroundTaskCount: 0 },
  };
  const rows = [];
  const updatedAt = { agentA: requestStartedSeq + 1 };
  const merged = mergeSessionStatusSnapshot(prev, rows, updatedAt, requestStartedSeq);
  assert.deepEqual(merged, { agentA: prev.agentA },
    'an agent SSE added after the GET began must survive the GET response, not be dropped by the snapshot replace');
});

test('mergeSessionStatusSnapshot does not resurrect an entry a newer SSE clear already removed', () => {
  const requestStartedSeq = 1_000_000;
  // SSE cleared agentA (session ended) after the GET began reading; `prev`
  // no longer has it, but the stale snapshot row the GET read before the
  // clear still shows it as live.
  const prev = {};
  const rows = [
    { agent_id: 'agentA', agent_name: 'A', keep_alive_until_ms: 1_010_000, background_task_count: 0 },
  ];
  const updatedAt = { agentA: requestStartedSeq + 1 };
  const merged = mergeSessionStatusSnapshot(prev, rows, updatedAt, requestStartedSeq);
  assert.deepEqual(merged, {},
    'a deferred stale GET row must not bring back an agent whose session a newer SSE already ended');
});

test('mergeSessionStatusSnapshot does not resurrect an entry whose SSE clear lands in the exact same tick the GET started', () => {
  // The bug this guards against: under the old Date.now()-based caller,
  // a GET issued and an SSE clear handled in the SAME millisecond produced
  // requestStartedAt === updatedAt, and `<=` treated that tie as "SSE is not
  // newer" — silently resurrecting an agent whose session had just ended.
  // With a monotonic sequence, "started" and "touched afterward" can never
  // land on the same ordinal: the caller captures requestStartedSeq as the
  // counter's value BEFORE any increment, and every SSE touch increments it
  // first — so the smallest possible "after" value is requestStartedSeq + 1,
  // never requestStartedSeq itself. This test locks in that boundary: an
  // updatedAt exactly EQUAL to requestStartedSeq (the tie point under the old
  // scheme) must still resolve as "not newer" (i.e. it represents "at/before
  // the GET began", never a real post-GET event), and a genuinely later SSE
  // touch (+1) must resolve as "newer" — proving there's no dead zone where a
  // same-tick clear could fall through and get stomped.
  const requestStartedSeq = 1_000_000;
  const rows = [
    { agent_id: 'agentA', agent_name: 'A', keep_alive_until_ms: 1_010_000, background_task_count: 0 },
  ];

  const tie = mergeSessionStatusSnapshot({}, rows, { agentA: requestStartedSeq }, requestStartedSeq);
  assert.deepEqual(tie, { agentA: { name: 'A', keepAliveUntilMs: 1_010_000, backgroundTaskCount: 0 } },
    'a touch stamped at exactly requestStartedSeq is "at/before GET start" by construction, so the snapshot row applies');

  const afterTie = mergeSessionStatusSnapshot({}, rows, { agentA: requestStartedSeq + 1 }, requestStartedSeq);
  assert.deepEqual(afterTie, {},
    'the very next sequence value after the tie point must still be honored as a real post-GET SSE clear');
});

test('mergeSessionStatusSnapshot prefers a newer SSE deadline extension over a stale GET snapshot row', () => {
  const requestStartedSeq = 1_000_000;
  const prev = {
    agentC: { name: 'C', keepAliveUntilMs: 2_000_000, backgroundTaskCount: 0 }, // SSE extended the deadline
  };
  const rows = [
    { agent_id: 'agentC', agent_name: 'C', keep_alive_until_ms: 1_010_000, background_task_count: 0 }, // pre-extension
  ];
  const updatedAt = { agentC: requestStartedSeq + 1 };
  const merged = mergeSessionStatusSnapshot(prev, rows, updatedAt, requestStartedSeq);
  assert.deepEqual(merged, { agentC: prev.agentC });
});

test('mergeSessionStatusSnapshot applies the snapshot row as-is when no newer SSE touched that agent', () => {
  const requestStartedSeq = 1_000_000;
  const prev = {};
  const rows = [
    { agent_id: 'agentB', agent_name: 'B', keep_alive_until_ms: 1_010_000, background_task_count: 0 },
  ];
  // Last SSE touch for agentB predates this GET request (or never happened) —
  // the ordinary room-entry-restore case with nothing racing it.
  const updatedAt = { agentB: requestStartedSeq - 500 };
  const merged = mergeSessionStatusSnapshot(prev, rows, updatedAt, requestStartedSeq);
  assert.deepEqual(merged, {
    agentB: { name: 'B', keepAliveUntilMs: 1_010_000, backgroundTaskCount: 0 },
  });
});
