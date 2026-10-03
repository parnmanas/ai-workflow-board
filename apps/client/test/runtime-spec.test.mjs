// P3b: RuntimeSpec 클라이언트 헬퍼 계약. React 없음 — 순수 함수만.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  emptyRuntimeSpec,
  isAbsoluteHostPath,
  isRuntimeSpecComplete,
  matchAgentForSpec,
  specSummary,
  workingDirLeaf,
} from '../src/runtime/runtimeSpec.ts';

test('empty spec is incomplete', () => {
  assert.equal(isRuntimeSpecComplete(emptyRuntimeSpec()), false);
});

test('complete requires host + cli + absolute dir', () => {
  const base = { ...emptyRuntimeSpec(), manager_agent_id: 'h1', cli: 'claude', working_dir: '/w' };
  assert.equal(isRuntimeSpecComplete(base), true);
  assert.equal(isRuntimeSpecComplete({ ...base, working_dir: 'relative/path' }), false);
  assert.equal(isRuntimeSpecComplete({ ...base, cli: '' }), false);
  assert.equal(isRuntimeSpecComplete({ ...base, manager_agent_id: '' }), false);
});

test('absolute path covers posix + windows', () => {
  assert.equal(isAbsoluteHostPath('/home/u/w'), true);
  assert.equal(isAbsoluteHostPath('C:\\work'), true);
  assert.equal(isAbsoluteHostPath('\\\\host\\share'), true);
  assert.equal(isAbsoluteHostPath('work/dir'), false);
});

test('summary renders host/cli/model/leaf', () => {
  assert.equal(
    specSummary({ manager_agent_id: 'h1', cli: 'claude', model: 'opus', working_dir: '/w/app' }, 'myhost'),
    'myhost/claude:opus @app',
  );
});

test('workingDirLeaf takes last segment', () => {
  assert.equal(workingDirLeaf('/a/b/c'), 'c');
  assert.equal(workingDirLeaf('C:\\a\\b'), 'b');
});

test('matchAgentForSpec matches the 5-key tuple', () => {
  const agents = [
    { id: 'a1', manager_agent_id: 'h1', type: 'Claude', model: 'opus', working_dir: '/w', credential_id: null },
    { id: 'a2', manager_agent_id: 'h1', type: 'claude', model: null, working_dir: '/w', credential_id: null },
  ];
  const spec = { manager_agent_id: 'h1', cli: 'claude', model: 'opus', working_dir: '/w', credential_id: null };
  assert.equal(matchAgentForSpec(agents, spec), 'a1');
  assert.equal(matchAgentForSpec(agents, { ...spec, model: 'other' }), null);
  assert.equal(matchAgentForSpec(agents, { ...spec, manager_agent_id: 'h2' }), null);
});
