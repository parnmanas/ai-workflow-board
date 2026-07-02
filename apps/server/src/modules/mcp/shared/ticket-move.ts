/**
 * 컬럼 이동 코어(다중담당자·합의 T5).
 *
 * `move_ticket` 툴 본문에 있던 이동 트랜잭션(포지션 시프트 · branch_tip 스냅샷
 * clear · terminal_entered_at 스탬프 · moved 활동 로그)을 순수 헬퍼로 추출한다.
 * 두 소비자가 **동일한** 이동 부작용을 공유하게 하려는 목적:
 *   1. `move_ticket` 툴 — 가드(terminal-reopen / review-approval / consensus)를
 *      통과한 뒤 이 헬퍼로 실제 이동.
 *   2. `record_agreement` auto-execute — 합의 성립 순간 서버가 이 헬퍼로 자동 이동.
 *
 * 가드는 **의도적으로 포함하지 않는다** — 합의 auto-execute 는 가드를 우회하는
 * 정당한 경로이고, 툴 쪽 가드는 호출측(move_ticket)이 이미 책임진다.
 */

import type { DataSource } from 'typeorm';
import { Ticket } from '../../../entities/Ticket';
import { BoardColumn } from '../../../entities/BoardColumn';
import type { ActivityService } from '../../../services/activity.service';
import { loadTicketFull } from './ticket-parsing';
import { shiftTicketPositions } from './ticket-helpers';
import { applyTerminalEnteredAtForMove } from './archive-helpers';

export interface PerformColumnMoveArgs {
  /** 이동할 티켓(현재 column_id/position 기준으로 시프트 계산). */
  ticket: Ticket;
  /** 목적지 컬럼 id. */
  destColumnId: string;
  /** 목적지 내 포지션(생략 시 끝). */
  position?: number;
  /** moved 활동 로그의 actor(감사). auto-execute 는 'consensus'/'Consensus'
   *  (non-'system' sentinel — 트리거 루프가 목적지 컬럼을 디스패치하게). */
  actorId?: string;
  actorName?: string;
  /** moved 활동의 trigger_source(감사 구분). */
  triggerSource?: string;
}

/**
 * 티켓을 다른 컬럼으로 이동시키는 코어 트랜잭션 + 활동 로그. `move_ticket` 툴의
 * 기존 이동 본문과 **동일한** 부작용을 낸다(포지션 시프트, branch_tip 스냅샷
 * clear, terminal_entered_at 스탬프, field_changed='column' moved 활동).
 *
 * 가드는 호출측 책임 — 이 함수는 순수 이동만 수행한다. 갱신된 티켓(loadTicketFull)
 * 을 반환한다.
 */
export async function performColumnMove(
  dataSource: DataSource,
  activityService: ActivityService,
  args: PerformColumnMoveArgs,
): Promise<Awaited<ReturnType<typeof loadTicketFull>>> {
  const { ticket, destColumnId, position } = args;
  const oldColumnId = ticket.column_id;

  await dataSource.transaction(async (manager) => {
    const tRepo = manager.getRepository(Ticket);

    await shiftTicketPositions(tRepo, { column_id: ticket.column_id }, ticket.position, -1);

    const destCount = await tRepo.createQueryBuilder('t')
      .where('t.column_id = :colId AND t.id != :id AND t.parent_id IS NULL', { colId: destColumnId, id: ticket.id })
      .getCount();
    const pos = Math.min(position ?? destCount, destCount);

    await shiftTicketPositions(tRepo, { column_id: destColumnId }, pos, +1, { inclusive: true, excludeId: ticket.id });

    // 클레임 검증 branch-tip 스냅샷 clear(ticket dcb9d661) — 이전 컬럼 클레임
    // 사이클이 닫히므로. 목적지가 활성 컬럼이면 다음 트리거가 재스냅샷한다.
    await tRepo.update(ticket.id, {
      column_id: destColumnId,
      position: pos,
      branch_tip_sha_at_trigger: '',
      branch_tip_snapshot_at: null,
    });

    // terminal 경계를 넘을 때 terminal_entered_at 스탬프/clear(아카이버 정확도).
    const colRepoTx = manager.getRepository(BoardColumn);
    const [sourceColForStamp, destColForStamp] = await Promise.all([
      oldColumnId ? colRepoTx.findOne({ where: { id: oldColumnId } }) : Promise.resolve(null),
      colRepoTx.findOne({ where: { id: destColumnId } }),
    ]);
    await applyTerminalEnteredAtForMove(tRepo, ticket.id, sourceColForStamp, destColForStamp);
  });

  // 활동 로그용 컬럼 이름 해석.
  const colRepo = dataSource.getRepository(BoardColumn);
  const [oldCol, newCol] = await Promise.all([
    colRepo.findOne({ where: { id: oldColumnId } }),
    colRepo.findOne({ where: { id: destColumnId } }),
  ]);

  await activityService.logActivity({
    entity_type: 'ticket', entity_id: ticket.id, action: 'moved',
    field_changed: 'column', old_value: oldCol?.name || String(oldColumnId),
    new_value: newCol?.name || String(destColumnId), ticket_id: ticket.id,
    actor_id: args.actorId, actor_name: args.actorName,
    ...(args.triggerSource ? { trigger_source: args.triggerSource } : {}),
  });

  return loadTicketFull(dataSource, ticket.id);
}
