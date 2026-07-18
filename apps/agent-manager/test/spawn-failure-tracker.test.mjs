// SpawnFailureTracker — CLI spawn 실패(예: Windows npm `.cmd` shim 의 codex
// ENOENT)가 5분마다 조용히 루프 도는 대신 AWB 관리자 대시보드에 드러나게 하는
// 매니저측 누적기(ticket e299c6b3).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpawnFailureTracker } from '../dist/lib/spawn-failure-tracker.js';

test('fresh tracker reports a clean snapshot', () => {
  const s = new SpawnFailureTracker().snapshot();
  assert.equal(s.spawn_failure_count, 0);
  assert.equal(s.last_spawn_error, null);
  assert.equal(s.last_spawn_error_cli, null);
  assert.equal(s.last_spawn_error_at, null);
});

test('record surfaces count + code-prefixed message + cli + iso timestamp', () => {
  const t = new SpawnFailureTracker();
  t.record({ cli: 'codex', code: 'ENOENT', message: 'spawn codex ENOENT' });
  const s = t.snapshot();
  assert.equal(s.spawn_failure_count, 1);
  assert.equal(s.last_spawn_error, 'ENOENT: spawn codex ENOENT');
  assert.equal(s.last_spawn_error_cli, 'codex');
  assert.equal(typeof s.last_spawn_error_at, 'string');
  assert.ok(s.last_spawn_error_at.length > 0);
});

test('spawn_failure_count is monotonic across failures', () => {
  const t = new SpawnFailureTracker();
  t.record({ cli: 'codex', code: 'ENOENT', message: 'x' });
  t.record({ cli: 'codex', code: 'ENOENT', message: 'x' });
  assert.equal(t.snapshot().spawn_failure_count, 2);
});

test('recordSuccess clears the degraded badge but keeps the informational total', () => {
  const t = new SpawnFailureTracker();
  t.record({ cli: 'codex', code: 'ENOENT', message: 'spawn codex ENOENT' });
  t.recordSuccess('codex');
  const s = t.snapshot();
  assert.equal(s.last_spawn_error, null); // 배지 지워짐 — CLI 회복
  assert.equal(s.last_spawn_error_cli, null);
  assert.equal(s.last_spawn_error_at, null);
  assert.equal(s.spawn_failure_count, 1); // 총계는 참고용으로 유지
});

test('recordSuccess for a different cli does not clear another cli failure', () => {
  const t = new SpawnFailureTracker();
  t.record({ cli: 'codex', code: 'ENOENT', message: 'boom' });
  t.recordSuccess('claude'); // claude 는 정상, codex 는 여전히 깨짐
  const s = t.snapshot();
  assert.equal(s.last_spawn_error, 'ENOENT: boom');
  assert.equal(s.last_spawn_error_cli, 'codex');
});

test('missing code omits the prefix', () => {
  const t = new SpawnFailureTracker();
  t.record({ cli: 'codex', message: 'generic failure' });
  assert.equal(t.snapshot().last_spawn_error, 'generic failure');
});

test('a very long message is truncated (no unbounded heartbeat payload)', () => {
  const t = new SpawnFailureTracker();
  t.record({ cli: 'codex', code: 'E', message: 'x'.repeat(1000) });
  assert.ok(t.snapshot().last_spawn_error.length <= 305); // 300자 cap + "E: " 접두
});

test('sustained repeats stay stable (repeat-alert path does not throw)', () => {
  const t = new SpawnFailureTracker();
  for (let i = 0; i < 12; i++) t.record({ cli: 'codex', code: 'ENOENT', message: 'loop' });
  assert.equal(t.snapshot().spawn_failure_count, 12);
  assert.equal(t.snapshot().last_spawn_error_cli, 'codex');
});
