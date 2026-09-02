import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../src/components/admin/ManagedAgentDialog.tsx', import.meta.url),
  'utf8',
);

test('Agent 설정은 현재 Agent workspace의 허용 프로필만 노출한다', () => {
  assert.match(source, /const wsId = \(mode === 'edit' && agent\?\.workspace_id\)/);
  assert.match(source, /api\.getWorkspaceClaudeBackendProfiles\(wsId\)/);
  assert.match(source, /data\.allowed_profile_ids\.includes\(profile\.id\)/);
  assert.match(source, /\.\.\.runtimeProfiles\.map\(profile => \(\{ value: profile\.id, label: profile\.name \}\)\)/);
});

test('삭제·재생성·workspace 변경으로 stale이 된 선택값은 상속 상태로 해제한다', () => {
  assert.match(
    source,
    /setRuntimeProfile\(current => \([\s\S]*?!current \|\| current === 'none' \|\| availableProfiles\.some\(profile => profile\.id === current\)[\s\S]*?: ''[\s\S]*?\)\);/,
  );
});

test('현재 workspace의 유효한 Claude 프로필은 저장 payload에 유지한다', () => {
  assert.match(
    source,
    /cli_runtime_profile: cli === 'claude' \? \(runtimeProfile \|\| null\) : 'none'/,
  );
});
