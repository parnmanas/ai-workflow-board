import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcileRuntimeProfileSelection,
  runtimeProfileForAgentUpdate,
} from '../src/utils/claudeRuntimeProfile.ts';

const profiles = [{ id: 'profile-valid', name: '유효 프로필' }];

test('프로필 조회 중에는 stale 선택값 대신 null을 수정 payload에 넣는다', () => {
  const payload = { cli_runtime_profile: runtimeProfileForAgentUpdate('claude', 'profile-stale', profiles, 'loading') };
  assert.equal(payload.cli_runtime_profile, null);
});

test('프로필 조회 성공 시 stale 선택을 해제하고 수정 payload로 전송하지 않는다', () => {
  const selection = reconcileRuntimeProfileSelection('profile-stale', profiles);
  const payload = { cli_runtime_profile: runtimeProfileForAgentUpdate('claude', selection, profiles, 'ready') };
  assert.equal(selection, '');
  assert.equal(payload.cli_runtime_profile, null);
});

test('권위 목록의 유효한 선택값은 수정 payload에 유지한다', () => {
  const selection = reconcileRuntimeProfileSelection('profile-valid', profiles);
  const payload = { cli_runtime_profile: runtimeProfileForAgentUpdate('claude', selection, profiles, 'ready') };
  assert.equal(payload.cli_runtime_profile, 'profile-valid');
});
