// P3a: 서버가 `agent_trigger` / `chat_request` 에 동봉하는 RuntimeSpec 스냅샷의
// 매니저 측 파싱 계약. 서버 모양(`apps/server/src/common/runtime-spec.ts` —
// runtimeSpecFromAgentRow)과 키 단위로 일치해야 하며, 어긋난 입력은 절대
// dispatch를 막지 않고 null로 낮춘다.

import assert from 'node:assert/strict';
import test from 'node:test';

import { findRuntimeContextEntry, matchRuntimeContextEntry, parseTriggerRuntime, runtimeIdentityKey } from '../dist/lib/event-dispatcher.js';

const FULL = {
  manager_agent_id: 'host-1',
  cli: 'Claude',
  model: 'opus',
  working_dir: '/work/app',
  folder_scope: 'shared',
  credential_id: null,
  cli_runtime_profile: null,
  runtime_config: { strategy: 'single', permission_mode: 'approve' },
  label: 'app/claude',
  role_prompt: 'be nice',
};

test('full snapshot parses with normalization (cli lowercased)', () => {
  const out = parseTriggerRuntime(FULL);
  assert.ok(out);
  assert.equal(out.cli, 'claude');
  assert.equal(out.model, 'opus');
  assert.equal(out.working_dir, '/work/app');
  assert.equal(out.label, 'app/claude');
  assert.deepEqual(out.runtime_config, { strategy: 'single', permission_mode: 'approve' });
});

test('JSON string form parses', () => {
  const out = parseTriggerRuntime(JSON.stringify(FULL));
  assert.ok(out);
  assert.equal(out.manager_agent_id, 'host-1');
});

test('null/undefined/empty string degrade to null', () => {
  assert.equal(parseTriggerRuntime(null), null);
  assert.equal(parseTriggerRuntime(undefined), null);
  assert.equal(parseTriggerRuntime(''), null);
  assert.equal(parseTriggerRuntime('   '), null);
});

test('missing any required key degrades to null', () => {
  const { manager_agent_id, ...noHost } = FULL;
  assert.equal(parseTriggerRuntime(noHost), null);
  const { cli, ...noCli } = FULL;
  assert.equal(parseTriggerRuntime(noCli), null);
  const { working_dir, ...noDir } = FULL;
  assert.equal(parseTriggerRuntime(noDir), null);
});

test('non-object degrades to null', () => {
  assert.equal(parseTriggerRuntime(42), null);
  assert.equal(parseTriggerRuntime([FULL]), null);
  assert.equal(parseTriggerRuntime('not-json{{{'), null);
});

test('tuple match: 4 keys equal (manager implicit self)', () => {
  const entry = { agent_id: 'a1', cli: 'Claude', working_dir: '/work/app', model: 'opus', credential_id: null };
  assert.equal(matchRuntimeContextEntry(entry, FULL), true);
});

test('tuple match: any key differs misses', () => {
  const entry = { agent_id: 'a1', cli: 'claude', working_dir: '/work/app', model: 'opus', credential_id: null };
  assert.equal(matchRuntimeContextEntry({ ...entry, cli: 'codex' }, FULL), false);
  assert.equal(matchRuntimeContextEntry({ ...entry, working_dir: '/other' }, FULL), false);
  assert.equal(matchRuntimeContextEntry({ ...entry, model: null }, FULL), false);
  assert.equal(matchRuntimeContextEntry({ ...entry, credential_id: 'c1' }, FULL), false);
  // cli case-insensitive
  assert.equal(matchRuntimeContextEntry({ ...entry, cli: 'CLAUDE' }, FULL), true);
});

test('find returns first match', () => {
  const entries = [
    { agent_id: 'a1', cli: 'codex', working_dir: '/work/app', model: null, credential_id: null },
    { agent_id: 'a2', cli: 'claude', working_dir: '/work/app', model: 'opus', credential_id: null },
  ];
  assert.equal(findRuntimeContextEntry(entries, FULL)?.agent_id, 'a2');
  assert.equal(findRuntimeContextEntry([], FULL), undefined);
});

test('identity key: stable, shaped, tuple-scoped', () => {
  const a = { cli: 'Claude', working_dir: '/work/app', credential_id: null };
  const b = { cli: 'claude', working_dir: '/work/app', credential_id: null };
  assert.equal(runtimeIdentityKey(a), runtimeIdentityKey(b)); // cli normalized
  assert.match(runtimeIdentityKey(a), /^rt-[0-9a-f]{16}$/);
  // model/label do not participate
  assert.equal(
    runtimeIdentityKey({ ...a }),
    runtimeIdentityKey(a),
  );
  const other = { cli: 'claude', working_dir: '/other', credential_id: null };
  assert.notEqual(runtimeIdentityKey(a), runtimeIdentityKey(other));
});

test('optional keys fall back without blocking', () => {
  const out = parseTriggerRuntime({
    manager_agent_id: 'host-1',
    cli: 'codex',
    working_dir: '/w',
  });
  assert.ok(out);
  assert.equal(out.model, null);
  assert.equal(out.folder_scope, 'shared');
  assert.equal(out.label, '');
  assert.equal(out.role_prompt, '');
});
