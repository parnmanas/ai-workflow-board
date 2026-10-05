/**
 * pend_ticket Action 게이트의 스코프 조회 (티켓 524bb434).
 *
 * 티켓의 workspace 에서 "실행 가능한" Action 후보를 모은다 — enabled = true 인
 * Action 만 (비활성은 스케줄러가 안 도는 것 — 게이트도 제외). 스코프를 못 구하면
 * (빈 workspace) 빈 배열을 돌려 게이트가 fail-open 하게 한다.
 *
 * DB 를 만지므로 순수 판정 로직(`pend-action-gate.ts`)과 분리한다 — 게이트는
 * DB 없이 테스트하고, 이 조회는 실제 DataSource 로 테스트한다.
 */
import type { DataSource } from 'typeorm';
import { Action } from '../../../entities/Action';
import type { PendActionCandidate } from './pend-action-gate';

export async function loadPendActionCandidates(
  dataSource: DataSource,
  ticket: { account_id?: string | null },
): Promise<PendActionCandidate[]> {
  const accountId = ticket.account_id || '';
  if (!accountId) return [];
  // Typed find (not raw SQL) so the boolean column transform holds on both
  // sqlite (0/1) and Postgres.
  const actions = await dataSource.getRepository(Action).find({
    where: { account_id: accountId, enabled: true },
    order: { name: 'ASC' },
  });
  return actions.map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    target_agent_id: a.target_agent_id,
  }));
}
