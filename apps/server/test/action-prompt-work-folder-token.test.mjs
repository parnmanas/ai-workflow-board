// renderActionPrompt: {{AWB_WORK_FOLDER}}는 그대로 통과시킨다 (티켓 9fd27487).
//
// renderActionPrompt는 평소 `{{var.path}}` 토큰을 모두 렌더 컨텍스트에 대입해
// 해석하고, 해석되지 않는 토큰은 ''로 축소한다(모듈 자신의 doc 주석 — "리터럴
// 토큰 텍스트로 폴백하는 것을 일부러 피한다" — 참고). 하지만 {{AWB_WORK_FOLDER}}는
// 패키지 경계를 넘나드는(CROSS-PACKAGE) wire 계약이다: agent-manager의
// prompts.ts에 있는 WORK_FOLDER_TOKEN을 그대로 미러링하며, 그 토큰은 다운스트림의
// composeChatRoomPrompt의 injectWorkFolder에서 해석된 절대경로
// `.awb/act/<leaf>` cwd로 치환된다 — 서버는 애초에 그 절대경로를 알지 못한다.
// 만약 Action 작성자가 프롬프트 템플릿에 {{AWB_WORK_FOLDER}}를 적어 넣으면,
// 기본 resolvePath 동작은 에이전트가 그 토큰을 보기도 전에 조용히 ''로
// 렌더링해버릴 것이다(이 모듈의 TOKEN_RE는 점으로 구분된 영숫자 경로라면
// 무엇이든 매치하며, 이 토큰도 예외가 아니다). 이 테스트는 리터럴 토큰을
// 그대로 유지하는 이 특수 케이스를 고정한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', 'dist');

const { renderActionPrompt, buildRenderContext } = await import(
  'file://' + path.join(DIST_ROOT, 'modules', 'actions', 'action-prompt.js')
);

const ctx = buildRenderContext({
  workspace: { id: 'ws-1', name: 'Acme' },
  agent: { id: 'agent-1', name: 'Builder' },
  action: { id: 'action-1', name: 'Deploy' },
  runId: 'run-1',
  now: new Date('2026-01-01T00:00:00.000Z'),
});

test('renderActionPrompt: {{AWB_WORK_FOLDER}} survives untouched — not resolved to empty string', () => {
  const rendered = renderActionPrompt('cd {{AWB_WORK_FOLDER}} && ./deploy.sh', ctx);
  assert.equal(rendered, 'cd {{AWB_WORK_FOLDER}} && ./deploy.sh');
});

test('renderActionPrompt: every OTHER unresolved token still collapses to empty string (unchanged behavior)', () => {
  const rendered = renderActionPrompt('hello {{nonexistent.path}} world', ctx);
  assert.equal(rendered, 'hello  world');
});

test('renderActionPrompt: ordinary {{var.path}} substitution is unaffected by the special case', () => {
  const rendered = renderActionPrompt(
    '{{action.name}} run {{run.id}} for {{workspace.name}} by {{agent.name}}',
    ctx,
  );
  assert.equal(rendered, 'Deploy run run-1 for Acme by Builder');
});

test('renderActionPrompt: {{AWB_WORK_FOLDER}} coexists with resolved tokens in the same template', () => {
  const rendered = renderActionPrompt(
    'Deploying {{action.name}} — work folder: {{AWB_WORK_FOLDER}}',
    ctx,
  );
  assert.equal(rendered, 'Deploying Deploy — work folder: {{AWB_WORK_FOLDER}}');
});

test('renderActionPrompt: every occurrence of {{AWB_WORK_FOLDER}} survives (agent-manager substitutes ALL occurrences)', () => {
  const rendered = renderActionPrompt(
    'cd {{AWB_WORK_FOLDER}} && echo "in {{AWB_WORK_FOLDER}}"',
    ctx,
  );
  assert.equal(rendered, 'cd {{AWB_WORK_FOLDER}} && echo "in {{AWB_WORK_FOLDER}}"');
});
