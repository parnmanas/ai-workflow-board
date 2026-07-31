/**
 * pend_ticket Action 게이트의 스코프 조회 (티켓 524bb434).
 *
 * 티켓 스코프에서 "실행 가능한" Action 후보를 모은다:
 *   - enabled = true 인 Action 만 (비활성은 스케줄러가 안 도는 것 — 게이트도 제외).
 *   - workspace-scope Action(board_id IS NULL)만 존재한다 — board_id는 65adf0b
 *     (카탈로그 board→workspace 승격)로 폐지된 레거시 컬럼이라 부트 마이그레이션
 *     이후 항상 NULL이며, 신규 board-scope Action 생성도 거부된다.
 * 스코프를 못 구하면(빈 workspace) 빈 배열을 돌려 게이트가 fail-open 하게 한다.
 *
 * DB 를 만지므로 순수 판정 로직(`pend-action-gate.ts`)과 분리한다 — 게이트는
 * DB 없이 테스트하고, 이 조회는 실제 DataSource 로 테스트한다.
 */
import { type DataSource, IsNull } from 'typeorm';
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
  // both sqlite (0/1) and Postgres.
  const actions = await dataSource.getRepository(Action).find({
    where: { workspace_id: workspaceId, enabled: true, board_id: IsNull() },
    order: { name: 'ASC' },
  });
  return actions.map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    target_agent_id: a.target_agent_id,
  }));
}
