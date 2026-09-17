import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * users.google_id — Google OAuth 로그인(유입 커밋 04e4ea41)이 계정을 연동하는 컬럼.
 *
 * 존재 여부 판정은 SQL 이 아니라 `queryRunner.hasColumn()` 으로 한다. 원래 이
 * 마이그레이션은 `ADD COLUMN IF NOT EXISTS` / `DROP COLUMN IF EXISTS` 를 그대로
 * 실행했는데, 그 두 구문은 Postgres 전용이라 SQLite(sql.js) 에서
 * `near "EXISTS": syntax error` 로 앱 부팅 자체를 깨뜨렸다 — 마이그레이션이
 * 부팅 경로에서 돌기 때문에 서버 통합 테스트가 전부 죽었다(티켓 d27336bb).
 *
 * 평소 이 마이그레이션은 양쪽 방언 모두에서 no-op 이다. db.ts 의 D-01 로
 * `synchronize` 가 모든 방언에서 켜져 있고 D-02/P-03 에 따라 마이그레이션은
 * synchronize 가 끝난 뒤에 돌므로, User 엔티티의 `@Column` 이 이미 만들어 둔
 * 컬럼을 다시 만나게 된다. 즉 여기 남은 역할은 synchronize 가 어떤 이유로든
 * 컬럼을 만들지 못한 DB 를 위한 안전망뿐이다.
 *
 * 방언 분기(`options.type === 'postgres'`) 대신 `hasColumn()` 을 쓴 이유: 분기는
 * SQLite 쪽을 통째로 건너뛰어 안전망을 없애지만, `hasColumn()` 은 두 방언에서
 * 똑같이 동작해 안전망을 유지한 채로 멱등성을 얻는다. 이웃 마이그레이션
 * `DropLastReadMessageIdColumn1760000000004`(런타임 존재 확인) 과
 * `PromoteBoardCatalogScopes1760000000069`(`hasColumn`) 이 같은 방식이다.
 */
export class AddUserGoogleId1760000000085 implements MigrationInterface {
  name = 'AddUserGoogleId1760000000085';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('users'))) return;
    if (await queryRunner.hasColumn('users', 'google_id')) return;
    await queryRunner.query(
      'ALTER TABLE users ADD COLUMN google_id VARCHAR DEFAULT NULL',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('users'))) return;
    if (!(await queryRunner.hasColumn('users', 'google_id'))) return;
    await queryRunner.query('ALTER TABLE users DROP COLUMN google_id');
  }
}
