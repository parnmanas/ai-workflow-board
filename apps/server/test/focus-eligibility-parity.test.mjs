// Drift guard — focus 점유 부적격 사유가 두 후보 쿼리에 모두 반영돼 있는가
// (ticket 2cc54fde).
//
// 이 티켓이 고친 교착의 원인은 로직 버그가 아니라 **목록의 어긋남**이었다.
// focus 후보 쿼리(`AgentWorkloadService.getWorkflowLoadTicketIds`)와 backlog
// 승격 후보 쿼리(`BacklogPromotionService.tryPromote`)가 각자 손으로 제외
// 조건을 나열하고 있었고, `canonical_ticket_id` 만 양쪽에서 빠져 있었다.
// dispatch 는 그 티켓을 거부하는데 focus 는 점유자로 세는 상태가 되어,
// 중복 티켓이 슬롯을 영구히 붙들었다.
//
// 실제 동작 검증은 `qa-flows/focus-lease-deadlock.test.mjs` 가 실서비스
// 경로를 띄워서 한다. 이 파일은 그 위에 얹는 값싼 정적 가드다: 사유 목록에
// 항목이 하나 늘었는데 SQL 필터 추가를 한쪽에서 빠뜨리면 여기서 걸린다.
// (사유가 늘 때는 이 가드만 고치지 말고 동작 테스트에 케이스를 함께 추가할
// 것 — 정적 일치는 "필터가 있다" 만 말해주지 "옳게 동작한다" 는 말해주지
// 않는다.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(__dirname, '..', 'src');
const DIST_ROOT = path.resolve(__dirname, '..', 'dist');

function readSource(...segments) {
  return fs.readFileSync(path.join(SRC_ROOT, ...segments), 'utf8');
}

// 각 후보 쿼리 블록만 잘라낸다. 파일 전체를 대상으로 grep 하면 주석이나
// 무관한 쿼리에 같은 컬럼명이 있는 것만으로 통과해 버려 가드가 공허해진다.
function sliceBetween(src, startNeedle, endNeedle, label) {
  const start = src.indexOf(startNeedle);
  assert.notEqual(start, -1, `${label}: '${startNeedle}' 를 찾지 못했다`);
  const end = src.indexOf(endNeedle, start);
  assert.notEqual(end, -1, `${label}: '${startNeedle}' 이후 '${endNeedle}' 를 찾지 못했다`);
  return src.slice(start, end);
}

/** focus 후보 쿼리 — `getWorkflowLoadTicketIds` 의 QueryBuilder 체인. */
function focusCandidateQuery() {
  const src = readSource('modules', 'agents', 'agent-workload.service.ts');
  return sliceBetween(
    src,
    "const qb = this.dataSource",
    'const rows: Array<{ id: string }>',
    'agent-workload.service.ts',
  );
}

/** 승격 후보 쿼리 — `tryPromote` 의 `candidates` QueryBuilder 체인. */
function promotionCandidateQuery() {
  const src = readSource('modules', 'agents', 'backlog-promotion.service.ts');
  return sliceBetween(
    src,
    'const candidates = await ticketRepo.createQueryBuilder',
    '.getMany();',
    'backlog-promotion.service.ts',
  );
}

test('focus 부적격 사유 목록이 두 후보 쿼리에 모두 필터로 존재한다', async () => {
  const { FOCUS_INELIGIBILITY_REASONS, FOCUS_INELIGIBILITY_COLUMNS } = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'agents', 'focus-eligibility.js')
  );

  // 가드 자체가 비어 있는 목록으로 공허하게 통과하지 않도록 최소 개수를 못박는다.
  assert.ok(
    FOCUS_INELIGIBILITY_REASONS.length >= 5,
    `사유 목록이 비정상적으로 짧다 (${FOCUS_INELIGIBILITY_REASONS.length}개)`,
  );

  const queries = [
    ['focus 후보 쿼리(getWorkflowLoadTicketIds)', focusCandidateQuery()],
    ['승격 후보 쿼리(tryPromote)', promotionCandidateQuery()],
  ];

  for (const reason of FOCUS_INELIGIBILITY_REASONS) {
    const column = FOCUS_INELIGIBILITY_COLUMNS[reason];
    assert.ok(column, `사유 '${reason}' 에 대응하는 컬럼이 FOCUS_INELIGIBILITY_COLUMNS 에 없다`);
    for (const [label, block] of queries) {
      assert.match(
        block,
        new RegExp(`\\.andWhere\\(\\s*['"]t\\.${column}\\b`),
        `${label} 에 '${reason}' 사유의 필터(t.${column})가 없다 — ` +
        'dispatch 가 거부하는 티켓이 focus 슬롯을 점유하는 교착이 재발한다',
      );
    }
  }
});

test('focusIneligibilityReason 이 각 사유를 실제로 판정한다', async () => {
  const { focusIneligibilityReason, isFocusEligible } = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'agents', 'focus-eligibility.js')
  );

  assert.equal(focusIneligibilityReason({}), null, '플래그가 없으면 점유 자격이 있어야 한다');
  assert.equal(isFocusEligible({}), true);

  assert.equal(focusIneligibilityReason({ archived_at: new Date() }), 'archived');
  assert.equal(focusIneligibilityReason({ canonical_ticket_id: 'abc' }), 'duplicate_link');
  assert.equal(focusIneligibilityReason({ pending_user_action: true }), 'pending_user_action');
  assert.equal(focusIneligibilityReason({ pending_on_tickets: true }), 'pending_on_tickets');
  assert.equal(focusIneligibilityReason({ pending_ci_wait: true }), 'pending_ci_wait');

  // sqlite 는 boolean 을 0/1 로 저장한다 — raw 결과의 숫자 표현도 받아야 한다.
  assert.equal(focusIneligibilityReason({ pending_on_tickets: 1 }), 'pending_on_tickets');
  assert.equal(focusIneligibilityReason({ pending_ci_wait: 0 }), null);
  assert.equal(focusIneligibilityReason({ canonical_ticket_id: '' }), null);
  assert.equal(focusIneligibilityReason(null), null);
});
