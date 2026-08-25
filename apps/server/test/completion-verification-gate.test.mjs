import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = rel => fs.readFileSync(path.join(here, '..', 'src', rel), 'utf8');

// 회귀 사례: Ontology Graph 재빌드 티켓에서 약속했던 운영 검증 다섯 항목이
// 코멘트에만 남아 merge 직후 Done 처리되었다. 이 fixture는 같은 조건을
// 구조화된 dedupe key로 등록할 수 있어야 한다.
const ONTOLOGY_GRAPH_POST_DEPLOY_FIXTURE = [
  'production-refresh-1',
  'production-refresh-2',
  'stable-key-count-comparison',
  'previous-snapshot-preserved',
  'related-ticket-and-chat-report',
];

test('Source 사례의 배포 후 검증을 각각 durable key로 표현한다', () => {
  assert.equal(new Set(ONTOLOGY_GRAPH_POST_DEPLOY_FIXTURE).size, 5);
  const entity = src('entities/TicketCompletionVerification.ts');
  assert.match(entity, /ticket_id.*dedupe_key[\s\S]*unique:\s*true/);
  assert.match(entity, /'pending'\s*\|\s*'passed'\s*\|\s*'failed'/);
});

test('모든 terminal 전이의 공통 원자 경계에서 미완료 검증을 차단한다', () => {
  const archive = src('modules/mcp/shared/archive-helpers.ts');
  const gate = src('modules/mcp/shared/completion-verification-gate.ts');
  assert.match(archive, /assertCompletionVerificationsPassed\(ticketRepo\.manager, ticketId, destColumn\)/);
  assert.match(gate, /destination\?\.kind\s*!==\s*'terminal'/);
  assert.match(gate, /destination\?\.is_terminal\s*!==\s*true/);
  assert.match(gate, /status:\s*'pending'/);
  assert.match(gate, /status:\s*'failed'/);
});

test('판정 재시도는 attempt key로 멱등하며 증거 코멘트와 같은 트랜잭션에 기록한다', () => {
  const attempt = src('entities/TicketCompletionVerificationAttempt.ts');
  const tools = src('modules/mcp/tools/completion-verification-tools.ts');
  assert.match(attempt, /verification_id.*attempt_key[\s\S]*unique:\s*true/);
  assert.match(tools, /\.orIgnore\(\)\.execute\(\)/);
  assert.match(tools, /commentRepo\.save/);
  assert.match(tools, /completion_verification_attempt_id/);
});
