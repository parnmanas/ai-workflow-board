// Unit test — F2-4 ⓒ (ticket d21b28fc) 결과물(artifact) 카드 캡처.
//
// 빌드/배포 tool 결과는 티켓 row 를 바꾸지 않아 ticket_refs 에 못 들어간다. 대신
// 별도 artifact_refs 로 캡처된다. 이 테스트가 세 tool(register_build_artifact ·
// report_build_failure · report_deployment)의 실제 결과 shape → ArtifactRef 매핑,
// fail-closed(에러/미인식 shape → 카드 없음), 그리고 propose_move 의 detail(승인 카드
// 배지) 캡처를 고정한다. tool-surface 분류는 tool-surface-parity.test 가 별도로 본다.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  trackedArtifactTool,
  resolveArtifactRef,
  resolveTicketRef,
  trackedTicketTool,
  chunkArtifactRefs,
  formatArtifactRefsContent,
  ARTIFACT_ACTION_TOOLS,
} from '../dist/lib/ticket-ref-capture.js';

test('trackedArtifactTool: 세 결과물 tool 만 추적, 나머지는 무시', () => {
  assert.deepEqual(trackedArtifactTool('mcp__awb__register_build_artifact', {}), { kind: 'build', tool: 'register_build_artifact' });
  assert.deepEqual(trackedArtifactTool('mcp__awb__report_build_failure', {}), { kind: 'build', tool: 'report_build_failure' });
  assert.deepEqual(trackedArtifactTool('mcp__awb__report_deployment', {}), { kind: 'deploy', tool: 'report_deployment' });
  // 티켓 mutation·read·비-결과물 tool 은 artifact 로 잡히지 않는다.
  assert.equal(trackedArtifactTool('mcp__awb__create_ticket', { title: 'X' }), null);
  assert.equal(trackedArtifactTool('mcp__awb__get_ticket', { ticket_id: 'T' }), null);
  assert.equal(trackedArtifactTool('Bash', { command: 'ls' }), null);
  assert.equal(trackedArtifactTool(undefined, {}), null);
});

test('ARTIFACT_ACTION_TOOLS: 정확히 세 tool → build/deploy 종류', () => {
  assert.deepEqual(ARTIFACT_ACTION_TOOLS, {
    register_build_artifact: 'build',
    report_build_failure: 'build',
    report_deployment: 'deploy',
  });
});

test('resolveArtifactRef register_build_artifact: 평평한 결과에서 target/status/commit', () => {
  const ctx = trackedArtifactTool('mcp__awb__register_build_artifact', {});
  // buildArtifactToJson → {id, target, status:'ok', commit_sha, artifact_path, host, ...}
  const ref = resolveArtifactRef(ctx, { id: 'B-1', target: 'server', status: 'ok', commit_sha: 'abcdef1234', host: 'ci' }, false);
  assert.deepEqual(ref, { kind: 'build', title: 'server', status: 'ok', commit: 'abcdef1234' });
});

test('resolveArtifactRef register_build_artifact: building 상태도 그대로 보존', () => {
  const ctx = trackedArtifactTool('mcp__awb__register_build_artifact', {});
  const ref = resolveArtifactRef(ctx, { target: 'client', status: 'building' }, false);
  assert.deepEqual(ref, { kind: 'build', title: 'client', status: 'building' });
});

test('resolveArtifactRef report_build_failure: 중첩 artifact 에서, status 기본 failed', () => {
  const ctx = trackedArtifactTool('mcp__awb__report_build_failure', {});
  // report_build_failure → ok({ artifact: buildArtifactToJson(status:'failed'), run_finalized, ... })
  const ref = resolveArtifactRef(ctx, { artifact: { target: 'server', status: 'failed', commit_sha: 'deadbeef99' }, run_finalized: true }, false);
  assert.deepEqual(ref, { kind: 'build', title: 'server', status: 'failed', commit: 'deadbeef99' });
  // status 누락 시 report_build_failure 는 'failed' 로 기본 채움(실패 경로 계약).
  const noStatus = resolveArtifactRef(ctx, { artifact: { target: 'server' } }, false);
  assert.deepEqual(noStatus, { kind: 'build', title: 'server', status: 'failed' });
});

test('resolveArtifactRef report_deployment: environment/base_url/deployed_commit_sha', () => {
  const ctx = trackedArtifactTool('mcp__awb__report_deployment', {});
  // report_deployment → {id, environment, base_url, deployed_commit_sha, source, deployed_at}
  const ref = resolveArtifactRef(ctx, {
    id: 'D-1', environment: 'production', base_url: 'https://app.example.com', deployed_commit_sha: 'cafe1234567', source: 'ci',
  }, false);
  assert.deepEqual(ref, { kind: 'deploy', title: 'production', status: 'deployed', commit: 'cafe1234567', url: 'https://app.example.com' });
  // url/commit 없어도 environment 만 있으면 카드는 뜬다(status=deployed 고정).
  const bare = resolveArtifactRef(ctx, { environment: 'staging' }, false);
  assert.deepEqual(bare, { kind: 'deploy', title: 'staging', status: 'deployed' });
});

test('resolveArtifactRef fail-closed: 에러·라벨 없음·미인식 shape → 카드 없음', () => {
  const build = trackedArtifactTool('mcp__awb__register_build_artifact', {});
  assert.equal(resolveArtifactRef(build, { target: 'server', status: 'ok' }, true), null, '에러 결과 → 카드 없음');
  assert.equal(resolveArtifactRef(build, { status: 'ok' }, false), null, 'target(라벨) 없으면 빌드 카드 무의미 → null');
  assert.equal(resolveArtifactRef(build, 'not an object', false), null, '비객체 결과 → null');
  const fail = trackedArtifactTool('mcp__awb__report_build_failure', {});
  assert.equal(resolveArtifactRef(fail, { run_finalized: true }, false), null, 'artifact 중첩 없으면 → null');
  const deploy = trackedArtifactTool('mcp__awb__report_deployment', {});
  assert.equal(resolveArtifactRef(deploy, { base_url: 'https://x' }, false), null, 'environment 없으면 배포 카드 → null');
});

test('chunkArtifactRefs: 서버 message-당 bound 초과분을 다중 카드로 분할(누락 없이)', () => {
  const refs = Array.from({ length: 21 }, (_, i) => ({ kind: 'build', title: `pkg-${i}` }));
  const chunks = chunkArtifactRefs(refs, 20);
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks.map((c) => c.length), [20, 1]);
  assert.equal(chunks.flat().length, 21, '21번째도 버려지지 않는다');
  assert.deepEqual(chunkArtifactRefs([], 20), [], '빈 입력 → 메시지 없음');
  assert.equal(chunkArtifactRefs(refs, 0).length, 1, 'size 0 → 단일 청크(방어)');
});

test('formatArtifactRefsContent: 메타 못 읽는 표면용 한글 텍스트 폴백', () => {
  const content = formatArtifactRefsContent([
    { kind: 'build', title: 'server', status: 'ok' },
    { kind: 'deploy', title: 'production', status: 'deployed' },
    { kind: 'build', title: 'client', status: 'failed' },
    { kind: 'weird', title: 'x' }, // 미매핑 종류 → 코드 그대로, status 없으면 생략
  ]);
  assert.equal(
    content,
    '📦 빌드: server (ok)\n📦 배포: production (deployed)\n📦 빌드: client (failed)\n📦 weird: x',
  );
});

// ── F2-4 ⓑ: propose_move 의 target_column.name → 승인 카드 배지용 detail ──────
test('resolveTicketRef propose: target_column.name 을 detail 로 싣는다(승인 카드 배지)', () => {
  const ctx = trackedTicketTool('mcp__awb__propose_move', { ticket_id: 'T-8', target_column_name: 'Review' });
  const ref = resolveTicketRef(ctx, { proposal: { id: 'CMT-p' }, target_column: { id: 'c-2', name: 'Review' }, consensus: {} }, false, () => '제안 티켓');
  assert.deepEqual(ref, { action: 'propose', ticket_id: 'T-8', title: '제안 티켓', detail: 'Review' });
  // target_column 없거나 name 이 비면 detail 은 생략(카드 본체는 그대로).
  const noCol = resolveTicketRef(ctx, { proposal: { id: 'CMT-p' } }, false, () => '제안 티켓');
  assert.deepEqual(noCol, { action: 'propose', ticket_id: 'T-8', title: '제안 티켓' });
});

test('resolveTicketRef: propose 아닌 action 은 detail 을 싣지 않는다', () => {
  const ctx = trackedTicketTool('mcp__awb__record_agreement', { ticket_id: 'T-9', status: 'agree' });
  const ref = resolveTicketRef(ctx, { comment: { id: 'CMT-a' }, target_column: { name: 'Done' }, consensus: {} }, false);
  assert.deepEqual(ref, { action: 'consensus', ticket_id: 'T-9' }, 'consensus 는 target_column 있어도 detail 없음');
});
