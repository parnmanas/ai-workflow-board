import { EntityManager } from 'typeorm';
import { OrchestrationMission } from '../entities/OrchestrationMission';

/**
 * 미션 타임라인 쓰기를 **미션 row** 에 직렬화한다(티켓 50031353).
 *
 * `ticket-comment-write-lock.ts` 의 미션 단위 대응물이고, 이유도 같다:
 * `write_seq` 는 "지금 DB 에 있는 최댓값 + 1" 로 유도되므로, 그 **읽기와 뒤이은
 * INSERT 사이**에 다른 호출이 끼어들면 둘이 같은 최댓값을 보고 같은 seq 로 쓴다.
 * 그러면 `(created_at, write_seq)` 가 전순서가 아니게 되어 커서 페이지네이션의
 * 경계에서 이벤트가 조용히 사라진다 — `write_seq` 가 존재하는 이유 자체가 무너진다.
 *
 * 미션 row 를 고르는 이유는 그것이 타임라인의 자연스러운 경합 단위이기 때문이다.
 * 서로 다른 미션의 기록은 막지 않으므로, append-only 핫 패스에서 직렬화 범위가
 * 필요 이상으로 넓어지지 않는다.
 *
 * Postgres/MySQL 은 트랜잭션마다 풀에서 다른 커넥션을 쓸 수 있어 명시적 row lock 이
 * 필요하다. sql.js 는 커넥션이 하나라 감싸는 트랜잭션 자체가 이미 직렬화 경계이고,
 * TypeORM 의 비관적 잠금 모드를 지원하지도 않는다.
 */
export async function lockMissionEventWrites(
  manager: EntityManager,
  missionId: string,
): Promise<void> {
  const driver = manager.connection.options.type;
  await manager.getRepository(OrchestrationMission).findOne({
    where: { id: missionId },
    ...(driver === 'postgres' || driver === 'mysql'
      ? { lock: { mode: 'pessimistic_write' as const } }
      : {}),
  });
}
