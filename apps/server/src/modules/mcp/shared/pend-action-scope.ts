/**
 * pend_ticket Action 게이트의 스코프 조회 (티켓 524bb434).
 *
 * 티켓 스코프에서 "실행 가능한" Action 후보를 모은다:
 *   - enabled = true 인 Action 만 (비활성은 스케줄러가 안 도는 것 — 게이트도 제외).
 *   - workspace-level Action(board_id IS NULL)은 항상 적용.
 *   - board-scope Action 은 이 티켓의 board 와 일치할 때만 적용.
 * 스코프를 못 구하면(빈 workspace/board) 빈 배열을 돌려 게이트가 fail-open 하게 한다.
 *
 * DB 를 만지므로 순수 판정 로직(`pend-action-gate.ts`)과 분리한다 — 게이트는
 * DB 없이 테스트하고, 이 조회는 실제 DataSource 로 테스트한다.
 */
import { type DataSource, type FindOptionsWhere, IsNull } from 'typeorm';
import { Action } from '../../../entities/Action';
import { Board } from '../../../entities/Board';
import { BoardColumn } from '../../../entities/BoardColumn';
import type { PendActionCandidate } from './pend-action-gate';

export async function loadPendActionCandidates(
  dataSource: DataSource,
  ticket: { column_id?: string | null; workspace_id?: string | null },
): Promise<PendActionCandidate[]> {
  const col = ticket.column_id
    ? await dataSource.getRepository(BoardColumn).findOne({ where: { id: ticket.column_id } })
    : null;
  const boardId = col?.board_id ?? null;

  let workspaceId = ticket.workspace_id || '';
  if (!workspaceId && boardId) {
    const board = await dataSource.getRepository(Board).findOne({ where: { id: boardId } });
    workspaceId = board?.workspace_id || '';
  }
  if (!workspaceId) return [];

  // Typed find (not raw SQL) so the boolean/null column transforms hold on
  // both sqlite (0/1) and Postgres. Workspace-level Actions (board_id IS NULL)
  // always apply; board-scoped Actions apply only when they match the ticket's
  // board — an OR expressed as two where-branches.
  const base: FindOptionsWhere<Action> = { workspace_id: workspaceId, enabled: true };
  const where: FindOptionsWhere<Action>[] = boardId
    ? [{ ...base, board_id: IsNull() }, { ...base, board_id: boardId }]
    : [{ ...base, board_id: IsNull() }];

  const actions = await dataSource.getRepository(Action).find({
    where,
    order: { name: 'ASC' },
  });
  return actions.map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    target_agent_id: a.target_agent_id,
    board_id: a.board_id,
  }));
}
