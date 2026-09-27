import { randomUUID } from 'node:crypto';
import { MigrationInterface, QueryRunner } from 'typeorm';
import { bindParams, localCronToUtc } from '../action-cron-timezone';

/**
 * `actions.schedule_cron` → `workspace_schedules` 이관.
 *
 * 왜: 크론 구현이 두 벌이었다. Action 쪽(`modules/actions/cron.ts`)은 **로컬시간**
 * tick-match 라 그 1분에 서버가 죽어 있으면 그날 실행이 조용히 사라졌고, `*`/정수만
 * 받았다. Workspace Schedule 쪽(`modules/qa/qa-cron.ts`)은 **UTC** 이고 `next_run_at`
 * 커서를 써서 놓친 실행을 따라잡으며 범위·목록도 받는다. 한쪽으로 모으면서 남긴 것은
 * 따라잡는 쪽이다. 이관 뒤 Action 은 "무엇을 · 누가 · 어디서" 만 정의하고, "언제" 는
 * 전부 Schedule 이 정한다.
 *
 * ── 시간대 (이 마이그레이션의 유일한 위험 지점) ────────────────────────────
 * 옛 크론은 **서버 로컬시간**으로 매칭됐고(`cronMatches` 가 `d.getHours()` 를 썼다),
 * 새 크론은 **UTC** 다. 그대로 옮기면 벽시계 시각이 통째로 밀린다. 그래서 각 행을
 * 이관할 때 **마이그레이션이 도는 서버의 UTC 오프셋만큼 시(hour) 를 되돌린다** —
 * 실행 시각이 달라지지 않는 것이 옮기는 쪽의 기본값이어야 한다.
 *
 * 되돌린 시가 자정을 넘으면 요일(dow)도 같이 밀어야 맞다. dow 가 `*` 가 아닌 행에서
 * 날짜가 넘어가는 경우만 dow 를 하루 당기거나 민다. dom/month 가 `*` 가 아니면서
 * 날짜가 넘어가는 조합은 옮기지 않고 **비활성으로** 만들어 둔다 — 조용히 틀린 날짜에
 * 도는 것보다 꺼진 채로 눈에 띄는 편이 낫다(실측상 그런 행은 없다).
 *
 * ── 무엇을 옮기고 무엇을 끄는가 ────────────────────────────────────────────
 * 크론이 걸린 Action 은 **전부** Schedule 로 옮긴다. 다만 **한 번도 성공한 적 없는**
 * Action 의 스케줄은 `enabled = false` 로 만든다.
 *
 * 근거(실측, 2026-09-27): 크론 4건 중 2건(TXIV 의 T3 perf sweep · T4 docs sync)이
 * 6일 연속 6/6 실패 중이었고 아무도 몰랐다. 매일 에이전트 세션만 태우고 산출물이
 * 없었다. 그런 스케줄을 살아 있는 채로 옮기면 같은 낭비가 그대로 이어진다.
 *
 * 지우지 않고 **끄는** 이유: 크론 식(`0 3 * * *`)은 사람이 정한 값이라 버리면
 * 복원할 근거가 없다. 꺼진 줄은 목록에 남아 운영자가 고친 뒤 켜거나 지울 수 있다.
 * 반대로 "성공 이력 있음" 을 기준으로 삼은 이유는, run 기록이 그 Action 이 실제로
 * 동작하는지에 대한 **이 저장소가 가진 유일한 객관적 증거**이기 때문이다. 특정
 * 배포의 Action UUID 를 마이그레이션에 박아 넣으면 다른 배포에서는 의미가 없다.
 *
 * 마지막으로 **모든** `actions.schedule_cron` 을 비운다(옮긴 것도, 끈 것도). 옛
 * 스케줄러는 이미 삭제됐으므로 값이 남아 있어도 돌지는 않지만, 남겨 두면 UI·MCP
 * 응답에 "이 Action 은 매일 04시에 돕니다" 라는 거짓말이 계속 보인다.
 *
 * 재실행 안전: 이미 그 Action 을 가리키는 스케줄이 있으면 건너뛴다. `schedule_cron`
 * 을 비우는 것도 멱등이다.
 *
 * down(): no-op. 이 저장소의 관례대로 되돌리면서 데이터를 지우지 않는다.
 */
export class MoveActionCronToWorkspaceSchedules1760000000088 implements MigrationInterface {
  name = 'MoveActionCronToWorkspaceSchedules1760000000088';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';

    // ── 스키마 (sqlite 는 synchronize 가 이미 만든다) ──
    if (isPostgres) {
      await queryRunner.query('ALTER TABLE workspace_schedules ADD COLUMN IF NOT EXISTS action_id VARCHAR');
      // Action 형태 스케줄은 이 두 값을 비워 둔다 — NOT NULL 이면 삽입이 막힌다.
      await queryRunner.query("ALTER TABLE workspace_schedules ALTER COLUMN target_agent_id SET DEFAULT ''");
      await queryRunner.query('ALTER TABLE workspace_schedules ALTER COLUMN target_agent_id DROP NOT NULL');
    }

    const rows: Array<{ id: string; workspace_id: string; name: string; schedule_cron: string; enabled: any }> =
      await queryRunner.query(
        "SELECT id, workspace_id, name, schedule_cron, enabled FROM actions WHERE schedule_cron IS NOT NULL AND schedule_cron <> ''",
      );
    if (!rows.length) return;

    // 이 서버의 UTC 오프셋(분). 옛 크론이 해석되던 기준이다.
    const offsetMinutes = -new Date().getTimezoneOffset();

    for (const action of rows) {
      const existing = await bindParams(queryRunner, 'SELECT id FROM workspace_schedules WHERE action_id = ?', [action.id]);
      if (existing.length) continue;

      const converted = localCronToUtc(action.schedule_cron, offsetMinutes);
      // 성공 이력 — 이 Action 이 실제로 동작했다는 유일한 객관적 증거.
      const [{ n }] = await bindParams<{ n: any }>(
        queryRunner,
        "SELECT COUNT(*) AS n FROM action_runs WHERE action_id = ? AND status = 'succeeded'",
        [action.id],
      );
      const everSucceeded = Number(n) > 0;
      const enabled = Boolean(action.enabled) && everSucceeded && converted.cron !== null;

      await bindParams(
        queryRunner,
        `INSERT INTO workspace_schedules
           (id, workspace_id, board_id, name, target_agent_id, task_prompt, action_id,
            cron, interval_ms, enabled, next_run_at, last_run_at, last_room_id,
            triggered_by_type, created_by)
         VALUES (?, ?, NULL, ?, '', '', ?, ?, NULL, ?, NULL, NULL, NULL, 'system', '')`,
        [
          randomUUID(),
          action.workspace_id,
          action.name,
          action.id,
          // 옮길 수 없는 식은 원문 그대로 남기고 위에서 꺼 둔다 — 운영자가 무엇을
          // 의도했는지는 보여야 고칠 수 있다.
          converted.cron ?? action.schedule_cron,
          // sqlite 는 boolean 컬럼이 정수다. 드라이버에 맡기지 않고 명시한다.
          isPostgres ? enabled : (enabled ? 1 : 0),
        ],
      );
    }

    await queryRunner.query("UPDATE actions SET schedule_cron = '' WHERE schedule_cron <> ''");
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {}
}
