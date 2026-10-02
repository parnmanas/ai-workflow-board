// Agent Manager 카드의 버전 액션 순수 로직(admin/managerUpdateAction.ts).
// 실행: node --import tsx --test apps/client/test/manager-update-action.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { installedVersionBadge, managerUpdateAction, updateFailureBadge } from '../src/components/admin/managerUpdateAction.ts';

test('disk newer than the running process → restart action, even when the registry has nothing newer', () => {
  const inst = { plugin_version: '1.6.246', latest_version: '1.6.247', update_available: true, installed_version: '1.6.247', restart_required: true, install_mode: 'npm-global' };
  const action = managerUpdateAction(inst);
  assert.equal(action.kind, 'restart');
  assert.equal(action.label, 'Restart to apply v1.6.247');
  assert.match(action.confirm, /already installed on this host/);
  assert.equal(installedVersionBadge(inst), 'installed v1.6.247 — restart required');
  // 레지스트리가 앞서도 디스크가 이미 새 빌드면 재기동이 먼저다(설치 없이 끝난다)
  assert.equal(managerUpdateAction({ ...inst, update_available: false }).kind, 'restart');
});

test('registry newer, disk equal to running → update action with npm-global wording', () => {
  const inst = { plugin_version: '1.6.246', latest_version: '1.6.247', update_available: true, installed_version: '1.6.246', restart_required: false, install_mode: 'npm-global' };
  const action = managerUpdateAction(inst);
  assert.equal(action.kind, 'update');
  assert.equal(action.label, 'Update → v1.6.247');
  assert.match(action.title, /npm i -g --ignore-scripts/);
  assert.equal(installedVersionBadge(inst), null);
  assert.match(managerUpdateAction({ ...inst, install_mode: 'unknown' }).title, /git pull/);
});

test('nothing to do / old manager', () => {
  assert.equal(managerUpdateAction({ plugin_version: '1.6.247', latest_version: '1.6.247', update_available: false, installed_version: '1.6.247', restart_required: false }).kind, 'latest');
  assert.equal(managerUpdateAction({ plugin_version: '1.6.200' }).kind, 'unknown');
  // restart_required 만 true 이고 installed_version 이 없으면(있을 수 없는 조합) 재기동을 권하지 않는다
  assert.notEqual(managerUpdateAction({ plugin_version: '1.6.246', restart_required: true, update_available: false }).kind, 'restart');
});

test('update failure badge: skipped version shows why it is not offered; new versions unaffected', () => {
  assert.equal(updateFailureBadge({ plugin_version: '1.6.264' }), null, '실패 없으면 배지 없음');
  const skipped = updateFailureBadge({
    plugin_version: '1.6.264', latest_version: '1.6.265', update_available: false,
    update_skipped_version: '1.6.265', update_failed_version: '1.6.265',
    update_failure_reason: 'boot verification failed for v1.6.265 (bad build v1.6.265)',
  });
  assert.equal(skipped.label, '(v1.6.265 skipped)');
  assert.match(skipped.title, /boot verification failed/);
  assert.match(skipped.title, /newer versions are still offered/);
  // 새 버전이 올라오면 스킵 표시 없이 실패 이력만 남는다 — 오퍼를 가리지 않는다.
  const history = updateFailureBadge({
    plugin_version: '1.6.264', latest_version: '1.6.266', update_available: true,
    update_skipped_version: null, update_failed_version: '1.6.265', update_failure_reason: 'boot verification failed',
  });
  assert.equal(history.label, '(v1.6.265 failed before)');
});
