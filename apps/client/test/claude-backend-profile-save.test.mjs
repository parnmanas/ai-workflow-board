import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../src/components/admin/ClaudeBackendProfilesManager.tsx', import.meta.url),
  'utf8',
);
const workspaceSource = await readFile(
  new URL('../src/components/WorkspaceManagementPage.tsx', import.meta.url),
  'utf8',
);

test('Claude backend profile 저장 payload에서 조회 전용 필드를 제외한다', () => {
  assert.match(source, /const \{ credential_status: _credentialStatus, \.\.\.editable \} = editing/);
  assert.match(source, /const payload = \{ \.\.\.editable,/);
  assert.match(source, /updateClaudeBackendProfile\(editing\.id, \{/);
});

test('저장 실패는 성공 처리 없이 오류 토스트로 표시한다', () => {
  assert.match(source, /catch \(e: any\) \{ showToast\(`프로필 저장 실패:/);
  assert.match(source, /await load\(\); edit\(\); showToast\('Claude backend profile saved', 'success'\)/);
});

test('현재 workspace Credential을 이름으로 검색하고 UUID는 선택 option value로만 사용한다', () => {
  assert.match(workspaceSource, /ClaudeBackendProfilesManager workspaceId=\{wsId\}/);
  assert.match(source, /api\.listCredentials\(workspaceId\)/);
  assert.match(source, /type="search"/);
  assert.match(source, /credential\.name\.toLocaleLowerCase\(\)\.includes/);
  assert.match(source, /<option value=\{credential\.id\}/);
  assert.doesNotMatch(source, /Credential ref \(UUID\)/);
});

test('Credential 신규 선택, 기존 값 표시, 변경과 해제를 UUID 계약으로 처리한다', () => {
  assert.match(source, /credentials\.find\(credential => credential\.id === editing\.credential_ref\)/);
  assert.match(source, /value=\{editing\.credential_ref \|\| ''\}/);
  assert.match(source, /credential_ref: e\.target\.value \|\| undefined/);
  assert.match(source, /credential_ref: editing\.credential_ref \|\| null/);
  assert.match(source, /<option value="">선택하지 않음<\/option>/);
});

test('삭제된 참조와 목록 로딩 실패를 구분하고 재시도를 제공한다', () => {
  assert.match(source, /invalidCredentialRef/);
  assert.match(source, /삭제되었거나 접근할 수 없는 Credential/);
  assert.match(source, /기존 선택값은 변경되지 않습니다/);
  assert.match(source, /onClick=\{loadCredentials\}>다시 시도/);
});
