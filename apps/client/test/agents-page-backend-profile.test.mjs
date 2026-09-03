import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcileRuntimeProfileSelection,
  runtimeProfileForManagedAgentCreate,
} from '../src/utils/claudeRuntimeProfile.ts';

const profiles = [{ id: 'profile-valid', name: '유효 프로필' }];

test('프로필 조회 전 생성 payload에는 stale 선택값을 넣지 않는다', () => {
  const payload = { cli_runtime_profile: runtimeProfileForManagedAgentCreate('claude', 'profile-stale', profiles, 'loading') };
  assert.equal(payload.cli_runtime_profile, undefined);
});

test('프로필 조회 실패 뒤 stale 선택을 해제하고 생성 payload에서도 제외한다', () => {
  const selection = reconcileRuntimeProfileSelection('profile-stale', []);
  const payload = { cli_runtime_profile: runtimeProfileForManagedAgentCreate('claude', selection, [], 'error') };
  assert.equal(selection, '');
  assert.equal(payload.cli_runtime_profile, undefined);
});

test('권위 목록의 유효한 선택값은 생성 payload에 유지한다', () => {
  const selection = reconcileRuntimeProfileSelection('profile-valid', profiles);
  const payload = { cli_runtime_profile: runtimeProfileForManagedAgentCreate('claude', selection, profiles, 'ready') };
  assert.equal(payload.cli_runtime_profile, 'profile-valid');
});
