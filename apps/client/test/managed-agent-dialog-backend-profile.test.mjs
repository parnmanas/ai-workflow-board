import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcileRuntimeProfileSelection,
  runtimeProfileForAgentUpdate,
  runtimeProfileSelectionReady,
} from '../src/utils/claudeRuntimeProfile.ts';

const profiles = [{ id: 'profile-valid', name: '유효 프로필' }];

test('기존 유효 ID가 있어도 프로필 조회 실패 시 수정 요청을 차단해 null 해제를 방지한다', () => {
  const existingSelection = 'profile-valid';
  let payload;

  if (runtimeProfileSelectionReady('claude', 'error')) {
    payload = {
      cli_runtime_profile: runtimeProfileForAgentUpdate(
        'claude', existingSelection, [], 'error',
      ),
    };
  }

  assert.equal(runtimeProfileSelectionReady('claude', 'error'), false);
  assert.equal(payload, undefined);
});

test('프로필 조회 중에도 Claude 수정 요청을 차단한다', () => {
  assert.equal(runtimeProfileSelectionReady('claude', 'loading'), false);
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
