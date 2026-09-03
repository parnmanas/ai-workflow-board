/**
 * 컬럼 이동 트랜잭션 안에서의 랜딩 lease 해제 (ticket e630b530, 설계 보정 D).
 *
 * Merging 이탈(Done 랜딩 / In Progress 바운스 / pend / 다른 어떤 컬럼으로든)과
 * lease 해제는 **원자적**이어야 한다. 둘을 따로 쓰면 그 사이에서 크래시했을 때
 * lease 가 절대 상한(기본 2시간)까지 새고, 그동안 같은 저장소의 다른 티켓이
 * 전부 대기한다.
 *
 * DI 없는 순수 함수인 이유: 이동 트랜잭션이 7군데에 흩어져 있고(MCP 공유 코어,
 * move_ticket_to_board, REST 3곳, agent-api 2곳) 그중 다수가 `MergeLeaseService`
 * 를 주입받지 않는다. `applyTerminalEnteredAtForMove` 가 이미 정확히 같은
 * 인자로 같은 7군데에서 불리고 있으므로, 그 바로 옆에 한 줄로 얹는다 — 새 이동
 * 표면이 생겨도 그 짝을 찾기 쉽고 grep 으로 누락을 확인할 수 있다.
 *
 * 절대 throw 하지 않는다. lease 해제 실패가 컬럼 이동 자체를 롤백시켜서는
 * 안 된다 — 놓친 행은 스윕의 리퍼가 백스톱으로 정리한다.
 */

import type { EntityManager, Repository } from 'typeorm';
import { IsNull } from 'typeorm';
import { BoardColumn } from '../../../entities/BoardColumn';
import { MergeLease } from '../../../entities/MergeLease';
import { Ticket } from '../../../entities/Ticket';

/**
 * 이동이 Merging 이탈이면 이 티켓의 열린 lease 를 해제하고 대기 플래그를 내린다.
 *
 * 홀더든 대기자든 똑같이 해제한다 — Merging 을 떠난 티켓은 어느 쪽으로도 그
 * 저장소의 랜딩 구간을 붙들 이유가 없다.
 *
 * `ticketRepo` 는 호출자가 이미 들고 있는 트랜잭션 매니저의 저장소여야 한다
 * (`applyTerminalEnteredAtForMove` 와 같은 계약) — 그래야 이동과 같은
 * 트랜잭션에서 커밋된다.
 */
export async function releaseMergeLeaseForMove(
  ticketRepo: Repository<Ticket>,
  ticketId: string,
  sourceColumn: BoardColumn | null | undefined,
  destColumn: BoardColumn | null | undefined,
): Promise<void> {
  try {
    // Merging 에서 나가는 이동만 대상이다. Merging 진입·내부 재정렬은 무관.
    if ((sourceColumn as any)?.kind !== 'merging') return;
    if ((destColumn as any)?.kind === 'merging') return;

    const reason = (destColumn as any)?.kind === 'terminal' ? 'landed' : 'left_merging';
    await releaseOpenLeaseRows(ticketRepo.manager, ticketId, reason);
  } catch {
    // 해제 실패로 이동을 롤백하지 않는다. 스윕 리퍼가 백스톱.
  }
}

/**
 * 티켓의 열린 lease 행을 닫고 대기 플래그를 내린다 — 조건 없이, 주어진
 * 트랜잭션 매니저 위에서.
 *
 * 이동 경로(`releaseMergeLeaseForMove`)와 명시적 해제 경로
 * (`MergeLeaseService.releaseWithinTx`)가 **같은 구현**을 쓰도록 여기 한 벌만
 * 둔다 — 두 벌이면 한쪽만 고쳐 서로 다르게 동작하는 것이 이 종류 버그의
 * 단골이다.
 *
 * lease 행이 하나도 없어도 대기 플래그는 정리한다: 고아 플래그가 남으면 그
 * 티켓의 트리거가 계속 드롭돼 조용히 멈춘다(자체 치유).
 *
 * @returns 실제로 닫힌 lease 행이 있었는지
 */
export async function releaseOpenLeaseRows(
  manager: EntityManager,
  ticketId: string,
  reason: string,
): Promise<boolean> {
  const now = new Date();
  const result = await manager.getRepository(MergeLease).update(
    { ticket_id: ticketId, released_at: IsNull() } as any,
    {
      released_at: now,
      release_reason: reason,
      last_progress_at: now,
      progress_note: `released:${reason}`,
    },
  );
  await manager.getRepository(Ticket).update(
    { id: ticketId, pending_merge_lease: true } as any,
    { pending_merge_lease: false, merge_lease_context: '' },
  );
  return (result.affected || 0) > 0;
}
