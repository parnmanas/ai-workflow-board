import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 다중담당자 T1 — `ticket_role_assignments` 유니크 완화 (foundation).
 *
 * 한 역할(phase)에 여러 홀더를 걸 수 있게 하기 위해, 역할당 유니크 키를
 *   `(ticket_id, role_id)`  →  `(ticket_id, role_id, holder_key)`
 * 로 완화한다. `holder_key` 는 홀더의 정규화 신원(`agent:<id>` / `user:<id>`)
 * 으로, 같은 홀더를 한 역할에 두 번 못 걸게 하면서도 서로 다른 홀더는 공존시킨다.
 * (Postgres 는 NULL 을 distinct 로 보므로 `(agent_id, user_id)` 원시 복합키로는
 * 같은 agent 를 두 번 넣는 걸 못 막는다 → 단일 `holder_key` 컬럼으로 우회.)
 *
 * ⚠️ 왜 명시 migration 인가: `db.ts` 는 전 환경 `synchronize:true` 지만,
 * **유니크 인덱스 drop/변경은 synchronize 가 안전하게 옮긴다는 보장이 없다**
 * (특히 Postgres). 옛 `uniq_ticket_role` 유니크가 살아남으면 두 번째 홀더
 * INSERT 가 조용히 막혀 T2 팬아웃이 통째로 깨진다. 그래서 여기서 명시적으로
 * 옛 인덱스를 drop 하고 새 인덱스를 만든다 (전부 IF EXISTS/IF NOT EXISTS 로
 * 멱등 — synchronize 가 이미 처리했든 안 했든 안전하게 수렴).
 *
 * 실행 순서: `synchronize` 가 DataSource.initialize() 에서 이미 `holder_key`
 * 컬럼(default '')과 새 인덱스를 만든 뒤, DatabaseModule.onModuleInit() 이
 * runMigrations() 를 호출 → 여기서 (1) 컬럼 보강 (2) 기존 행 backfill
 * (3) 옛 유니크 drop (4) 새 유니크 보장. 옛 유니크가 (ticket_id, role_id) 로
 * 행당 1개를 이미 보장했으므로 backfill 후에도 (ticket_id, role_id, holder_key)
 * 는 자명히 유니크 — CREATE 가 충돌하지 않는다.
 *
 * 인덱스 DDL 은 Postgres/SQLite 양쪽 문법이 동일(`DROP INDEX IF EXISTS`,
 * `CREATE UNIQUE INDEX IF NOT EXISTS`)해 두 dialect 모두에서 실행한다 —
 * sql.js(dev) 에서 synchronize 가 옛 인덱스를 확실히 못 떼는 경우까지 방어.
 * 컬럼 ADD/DROP 만 Postgres 전용(sqlite 는 synchronize 가 컬럼을 담당).
 */
export class RelaxTicketRoleUniqueMultiHolder1760000000045 implements MigrationInterface {
  name = 'RelaxTicketRoleUniqueMultiHolder1760000000045';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';

    // 1. holder_key 컬럼 보강 (Postgres 명시; sqlite 는 synchronize 가 이미 생성).
    if (isPostgres) {
      await queryRunner.query(
        `ALTER TABLE ticket_role_assignments ADD COLUMN IF NOT EXISTS holder_key varchar NOT NULL DEFAULT ''`,
      );
    }

    // 2. 기존 행 backfill — computeHolderKey() 와 정확히 동일한 포맷.
    //    아직 비어있는(홀더키 미기록) 행만 건드려 멱등 유지. agent 우선.
    await queryRunner.query(
      `UPDATE ticket_role_assignments
         SET holder_key = CASE
           WHEN agent_id IS NOT NULL AND agent_id <> '' THEN 'agent:' || agent_id
           WHEN user_id  IS NOT NULL AND user_id  <> '' THEN 'user:'  || user_id
           ELSE ''
         END
       WHERE holder_key IS NULL OR holder_key = ''`,
    );

    // 3. 옛 단일-홀더 유니크 drop → 새 다중-홀더 유니크 보장. 전부 멱등.
    await queryRunner.query(`DROP INDEX IF EXISTS uniq_ticket_role`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uniq_ticket_role_holder
         ON ticket_role_assignments (ticket_id, role_id, holder_key)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';

    // 다중-홀더 유니크 제거. 옛 유니크 복원은 best-effort — 한 역할에 홀더가
    // 2명 이상인 행이 이미 존재하면 (ticket_id, role_id) 유니크 재생성이 실패할
    // 수 있으므로 실패를 삼킨다(롤백 시점에 다중담당자 데이터가 있으면 애초에
    // 옛 스키마로 되돌릴 수 없는 게 정상).
    await queryRunner.query(`DROP INDEX IF EXISTS uniq_ticket_role_holder`);
    try {
      await queryRunner.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS uniq_ticket_role
           ON ticket_role_assignments (ticket_id, role_id)`,
      );
    } catch {
      // 다중-홀더 데이터 존재 → 옛 유니크 복원 불가. 무시.
    }
    if (isPostgres) {
      await queryRunner.query(
        `ALTER TABLE ticket_role_assignments DROP COLUMN IF EXISTS holder_key`,
      );
    }
  }
}
