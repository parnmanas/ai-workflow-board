import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Action 다중 에이전트 대상(fan-out) 지원 (티켓 fc3906c5). 세 컬럼 + 인덱스:
 *
 *   - actions.target_agent_ids  — 대상 에이전트 id의 JSON 배열. 기존 단일
 *     `target_agent_id` 는 **삭제하지 않고** 대표 대상 미러로 남긴다.
 *   - action_runs.agent_id      — 이 run을 수행하는 에이전트(에이전트별 감사).
 *   - action_runs.batch_id      — 같은 트리거에서 fan-out된 run들의 묶음 키.
 *
 * SQLite(개발)는 엔티티 synchronize=true 로 이 컬럼들을 얻는다. 이 DDL은
 * synchronize가 꺼져 있는 Postgres(운영) 에서만 돈다. 전부
 * `ADD COLUMN IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` 라 이미 적용된 DB에
 * 재실행해도 no-op이다.
 *
 * 백필은 `actions.target_agent_ids` 에만 한다. 기존 단일 대상 Action의 배열을
 * `["<target_agent_id>"]` 로 채워 두 컬럼의 정합을 맞춘다. 이 백필은 **동작의
 * 전제가 아니라 데이터 정합성용**이다 — 읽기 경로(`actionTargetAgentIds()`)가
 * 빈 배열이면 레거시 단일 컬럼으로 폴백하므로, 백필이 돌지 않아도 기존 Action은
 * 그대로 동작한다.
 *
 * `action_runs.agent_id` 는 **의도적으로 백필하지 않는다.** 과거 run이 어느
 * 에이전트로 갔는지는 그 시점의 Action 대상이 정답인데, 그 값은 이후 편집으로
 * 바뀌었을 수 있다. 현재 대상을 과거 run에 적어 넣으면 감사 기록을 지어내는
 * 것이므로, 레거시 run은 ''로 두고 UI가 "기록 없음"으로 표시한다.
 *
 * down()은 이 저장소의 컬럼 추가 마이그레이션 관례대로 no-op이다. 되돌리면서
 * 컬럼을 DROP하면 그 사이 저장된 fan-out 대상 설정이 통째로 사라진다 — 앞선
 * 마이그레이션들과 같은 이유로 데이터를 지우지 않는다.
 */
export class AddActionFanOutTargets1760000000084 implements MigrationInterface {
  name = 'AddActionFanOutTargets1760000000084';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) return;

    await queryRunner.query(
      "ALTER TABLE actions ADD COLUMN IF NOT EXISTS target_agent_ids VARCHAR NOT NULL DEFAULT '[]'",
    );
    await queryRunner.query(
      "ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS agent_id VARCHAR NOT NULL DEFAULT ''",
    );
    await queryRunner.query(
      "ALTER TABLE action_runs ADD COLUMN IF NOT EXISTS batch_id VARCHAR NOT NULL DEFAULT ''",
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_action_runs_batch_id ON action_runs (batch_id)',
    );

    // 기존 단일 대상 → 배열 백필. 아직 비어 있는 행만 건드리므로 재실행해도
    // 이미 다중 대상으로 편집된 Action을 덮어쓰지 않는다. agent id는 UUID라
    // JSON 이스케이프가 필요한 문자가 들어갈 수 없다.
    await queryRunner.query(
      `UPDATE actions
          SET target_agent_ids = '["' || target_agent_id || '"]'
        WHERE (target_agent_ids IS NULL OR target_agent_ids = '' OR target_agent_ids = '[]')
          AND target_agent_id IS NOT NULL
          AND target_agent_id <> ''`,
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {}
}
