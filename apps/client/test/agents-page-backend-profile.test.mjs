// AgentsPage 인라인 "New Agent" 생성 폼에 Claude backend profile selector가
// 없어 workspace의 실제 Agent 생성 화면에서는 프로필을 고를 수도, create 요청에
// cli_runtime_profile을 실어 보낼 수도 없던 회귀(리뷰 코멘트, 티켓 29ea479c) 를
// 고정한다. admin/ManagedAgentDialog.tsx 는 이미 고쳐져 있었지만 그건 관리자
// 전용 경로이고, workspace AI Agents 페이지가 실제로 쓰는 폼은 별도
// `managedForm` state + `handleCreateManagedAgent`(AgentsPage.tsx)라 커버되지
// 않았다.
//
// 이 레포에는 jsdom이 없어(apps/client/test/README.md) 풀 마운트 렌더링을
// 못한다 — 기존 runtime-host-only-ui.test.mjs와 동일하게 소스 텍스트 단언으로
// (a) selector가 실제로 렌더되는지, (b) 선택값이 createManagedAgent 요청
// body의 cli_runtime_profile로 정확히 전달되는지 고정한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../src/components/AgentsPage.tsx', import.meta.url),
  'utf8',
);

test('AgentsPage loads workspace-scoped Claude backend profiles for the create form', () => {
  assert.match(source, /api\.getWorkspaceClaudeBackendProfiles\(wsId\)/);
  // Only the workspace's allowed profiles must be offered — mirrors
  // ManagedAgentDialog so a profile disabled for this workspace can't be
  // picked from AgentsPage even though the registry still returns it.
  assert.match(source, /data\.allowed_profile_ids\.includes\(p\.id\)/);
  assert.match(
    source,
    /availableProfiles\.some\(profile => profile\.id === form\.runtime_profile\)[\s\S]*?runtime_profile: ''/,
    'workspace 변경 뒤 남은 stale profile 선택은 상속 상태로 해제해야 한다',
  );
});

test('create form renders a Claude backend profile selector for claude agents', () => {
  assert.match(source, /managedForm\.runtime\.runtime === 'claude'/);
  assert.match(source, /label="Claude backend profile"/);
  assert.match(source, /value=\{managedForm\.runtime_profile\}/);
  // Inherit / explicit-none sentinels, same copy as ManagedAgentDialog.
  assert.match(source, /label: 'Inherit board\/workspace'/);
  assert.match(source, /value: 'none', label: 'None — Anthropic default'/);
  assert.match(source, /runtimeProfiles\.map\(p => \(\{ value: p\.id, label: p\.name \}\)\)/);
});

test('create payload carries the selected backend profile as cli_runtime_profile', () => {
  // Non-claude CLIs (and an unselected profile) must omit the field so the
  // server falls back to inherit — same create-mode rule ManagedAgentDialog
  // uses (cli === 'claude' && runtimeProfile ? runtimeProfile : undefined).
  assert.match(
    source,
    /const cli_runtime_profile = managedForm\.runtime\.runtime === 'claude' && managedForm\.runtime_profile\s*\n\s*\? managedForm\.runtime_profile\s*\n\s*: undefined;/,
  );
  // And it must actually be threaded into the ManagedAgentCreateBody sent
  // to api.createManagedAgent — a selector that updates state but never
  // reaches the request body would still fail requirement #4.
  const bodyMatch = source.match(/const body: ManagedAgentCreateBody = \{[\s\S]*?\};/);
  assert.ok(bodyMatch, 'expected a ManagedAgentCreateBody literal in handleCreateManagedAgent');
  assert.match(bodyMatch[0], /cli_runtime_profile,/);
});
