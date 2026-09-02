/**
 * Focus 점유 자격(focus eligibility)의 단일 정의 — ticket 2cc54fde.
 *
 * 이 코드베이스의 "focus lease" 는 저장된 락이 아니라 계산된 값이다:
 * `AgentWorkloadService.getWorkflowLoadTicketIds` 가 돌려주는 후보 집합에
 * 티켓이 들어 있으면 그 티켓이 담당자의 focus 슬롯을 점유한 것이고, 집합에서
 * 빠지는 순간 lease 가 해제된 것이다. 따라서 "lease 를 원자적으로 해제한다"
 * 는 곧 "상태 플래그를 바꿔 후보 쿼리에서 즉시 제외한다" 이며, 별도의 해제
 * 트랜잭션이나 보상 로직이 필요 없다 — 플래그를 쓰는 그 트랜잭션이 해제
 * 시점이다.
 *
 * 문제는 그 제외 목록이 두 곳(focus 후보 쿼리와 backlog 승격 후보 쿼리)에
 * 손으로 복제돼 있었고 실제로 어긋났다는 점이다. dispatch 경로
 * (`TriggerLoopService._emitTrigger` / `dispatchCurrentColumn` /
 * `dispatchCurrentColumnRole`) 는 `canonical_ticket_id` 가 붙은 중복 티켓의
 * 트리거를 전부 버리는데, focus 후보 쿼리는 그 티켓을 계속 점유자로 셌다.
 * 결과적으로 중복 티켓은 영원히 dispatch 되지 않으면서 슬롯만 붙들었고,
 * canonical/선행 티켓 승격이 `backlog_promotion_skipped_focus_held` 로 무한
 * 차단됐다 — 수동 archive 전까지 풀리지 않는 교착.
 *
 * 여기서는 그 "점유 부적격 사유" 를 한 곳에 이름 붙여 정의한다. SQL 필터
 * 자체는 각 쿼리 빌더에 인라인으로 남아 있지만(기존 정적 가드들이 그 줄을
 * 직접 검사한다), 사유 판정과 감사 로그는 이 헬퍼를 공유하므로 두 목록이
 * 다시 어긋나면 `test/focus-eligibility-parity.test.mjs` 가 잡아낸다.
 */

import { DataSource } from 'typeorm';
import { BoardColumn } from '../../entities/BoardColumn';
import { activityEvents } from '../../services/activity.service';

/**
 * 티켓이 focus 슬롯을 점유할 수 없는 사유. 판정 순서는
 * `focusIneligibilityReason` 의 검사 순서와 같다(먼저 걸리는 사유가 이긴다).
 */
export type FocusIneligibilityReason =
  | 'archived'
  | 'duplicate_link'
  | 'pending_user_action'
  | 'pending_on_tickets'
  | 'pending_ci_wait';

/**
 * 위 union 의 런타임 목록. focus 후보 SQL 과 이 헬퍼가 같은 사유 집합을 보고
 * 있는지 정적 가드가 대조하는 기준이며, 사유가 늘어날 때 SQL 쪽 필터 추가를
 * 빠뜨리면 그 가드가 실패한다.
 */
export const FOCUS_INELIGIBILITY_REASONS: readonly FocusIneligibilityReason[] = [
  'archived',
  'duplicate_link',
  'pending_user_action',
  'pending_on_tickets',
  'pending_ci_wait',
];

/**
 * 각 사유가 대응하는 Ticket 컬럼. 정적 가드가 "이 컬럼이 두 후보 쿼리에
 * 모두 필터로 들어가 있는가" 를 확인하는 데 쓴다.
 */
export const FOCUS_INELIGIBILITY_COLUMNS: Readonly<Record<FocusIneligibilityReason, string>> = {
  archived: 'archived_at',
  duplicate_link: 'canonical_ticket_id',
  pending_user_action: 'pending_user_action',
  pending_on_tickets: 'pending_on_tickets',
  pending_ci_wait: 'pending_ci_wait',
};

/**
 * `focusIneligibilityReason` 가 읽는 최소 필드 집합. Ticket 엔티티도 어떤
 * `@Injectable` 서비스도 import 하지 않는 구조적 타입이라, tickets 모듈 쪽
 * 서비스들이 이 모듈을 가져다 써도 agents 모듈과 순환 import 가 생기지
 * 않는다(이 파일이 끌어오는 것은 엔티티 하나와 이벤트 버스뿐이며, 둘 다
 * 그 서비스들이 이미 import 하고 있다).
 */
export interface FocusEligibilityInput {
  archived_at?: Date | string | null;
  canonical_ticket_id?: string | null;
  pending_user_action?: boolean | number | null;
  pending_on_tickets?: boolean | number | null;
  pending_ci_wait?: boolean | number | null;
}

// sqlite 는 boolean 을 0/1 로 저장한다. 엔티티를 통해 읽으면 boolean 으로
// 돌아오지만 raw 쿼리 결과는 숫자일 수 있으므로 양쪽을 모두 받는다.
function isTrue(v: boolean | number | null | undefined): boolean {
  return v === true || v === 1;
}

/**
 * 티켓이 focus 슬롯을 점유할 자격이 없다면 그 사유를, 정상 점유 가능하면
 * null 을 돌려준다. 순수 함수 — DB 접근 없음.
 */
export function focusIneligibilityReason(
  ticket: FocusEligibilityInput | null | undefined,
): FocusIneligibilityReason | null {
  if (!ticket) return null;
  if (ticket.archived_at) return 'archived';
  if (ticket.canonical_ticket_id) return 'duplicate_link';
  if (isTrue(ticket.pending_user_action)) return 'pending_user_action';
  if (isTrue(ticket.pending_on_tickets)) return 'pending_on_tickets';
  if (isTrue(ticket.pending_ci_wait)) return 'pending_ci_wait';
  return null;
}

/** `focusIneligibilityReason(...) === null` 의 가독용 별칭. */
export function isFocusEligible(ticket: FocusEligibilityInput | null | undefined): boolean {
  return focusIneligibilityReason(ticket) === null;
}

/**
 * lease 해제 브로드캐스트 — `activityEvents` 버스에 실린다.
 *
 * lease 해제는 후보 쿼리에서 빠지는 것만으로 이미 완료되지만, 그 사실을
 * backlog 승격이 알아채는 시점은 다음 `agent_idle` 이벤트 아니면 5분짜리
 * level sweep 이다. 교착을 푼 직후 최대 5분을 더 멈춰 있는 것은 이 티켓이
 * 고치려는 증상 그 자체이므로, 해제한 쪽이 이 이벤트를 쏘고
 * `BacklogPromotionService` 가 받아 즉시 승격을 재시도한다.
 *
 * 발행은 반드시 상태를 쓴 트랜잭션이 커밋된 뒤에 한다 — sql.js 백엔드는 단일
 * 커넥션이라 커밋 전에 쏘면 리스너의 쓰기가 발행자의 트랜잭션과 겹친다.
 */
export const FOCUS_RELEASED_EVENT = 'focus_released';

export interface FocusReleasedPayload {
  ticket_id: string;
  board_id: string;
  reason: FocusIneligibilityReason;
}

/**
 * lease 를 해제한 쪽이 부르는 발행 헬퍼. 티켓의 컬럼에서 board_id 를 풀어
 * `FOCUS_RELEASED_EVENT` 를 쏜다.
 *
 * 호출 규약:
 *   - 상태를 쓴 **트랜잭션이 커밋된 뒤에** 부를 것. sql.js 백엔드는 단일
 *     커넥션이라, 커밋 전에 쏘면 리스너의 승격 쓰기가 발행자의 트랜잭션과
 *     겹친다.
 *   - 실패는 삼킨다. 이 신호는 지연 단축용 최적화일 뿐이고, 5분 level sweep
 *     이 여전히 최종 백스톱이다 — 여기서 던져 호출자의 정상 경로를 깨뜨리는
 *     쪽이 훨씬 나쁘다.
 *   - 컬럼이 없는 티켓(child/subtask)은 board 를 특정할 수 없으므로 조용히
 *     넘어간다. 그런 티켓은 애초에 focus 슬롯을 잡지 않는다.
 */
export async function emitFocusReleased(
  dataSource: DataSource,
  ticket: { id: string; column_id?: string | null },
  reason: FocusIneligibilityReason,
): Promise<void> {
  try {
    if (!ticket?.id || !ticket.column_id) return;
    const column = await dataSource
      .getRepository(BoardColumn)
      .findOne({ where: { id: ticket.column_id }, select: ['id', 'board_id'] });
    const boardId = column?.board_id || '';
    if (!boardId) return;
    const payload: FocusReleasedPayload = { ticket_id: ticket.id, board_id: boardId, reason };
    activityEvents.emit(FOCUS_RELEASED_EVENT, payload);
  } catch {
    // 위 규약대로 의도적으로 무시한다.
  }
}
