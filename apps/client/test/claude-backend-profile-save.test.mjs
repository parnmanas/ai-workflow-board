import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../src/components/admin/ClaudeBackendProfilesManager.tsx', import.meta.url),
  'utf8',
);

test('Claude backend profile 저장 payload에서 조회 전용 필드를 제외한다', () => {
  assert.match(source, /const \{ credential_status: _credentialStatus, \.\.\.editable \} = editing/);
  assert.match(source, /const payload = \{ \.\.\.editable,/);
  assert.match(source, /updateClaudeBackendProfile\(editing\.id, payload\)/);
});

test('저장 실패는 성공 처리 없이 오류 토스트로 표시한다', () => {
  assert.match(source, /catch \(e: any\) \{ showToast\(`프로필 저장 실패:/);
  assert.match(source, /await load\(\); edit\(\); showToast\('Claude backend profile saved', 'success'\)/);
});
