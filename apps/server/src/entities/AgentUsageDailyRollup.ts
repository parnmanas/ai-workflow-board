import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Unique, Index } from 'typeorm';

/**
 * AgentUsageDailyRollup — `Subagent` usage를 영속적으로 일별 누적하는 테이블
 * (ticket 8d5c6f5d, 6dd3f968 후속).
 *
 * `AgentUsageService.getTokenUsageStats()`는 `subagents`를 직접 읽지만, ended
 * row는 종료 후 `SUBAGENT_ENDED_RETENTION_HOURS`(기본 48h) 지나면 reap되므로
 * (`SubagentMonitorService._sweepEnded()`) 그 메서드는 retention 이내의 윈도우
 * 질의만 안전하다. 이 테이블이 영속 쪽을 맡는다: (workspace_id, usage_date,
 * agent_id) 당 1행이며, sweep이 원본 row를 지우는 것과 **같은 트랜잭션**에서
 * 배치의 usage를 여기 접어 넣는다 — 별도 cron 없음. 그래서 어떤 row도
 * `subagents`에 "live"로 있으면서 동시에 여기 "rolled up"으로 있을 수 없고
 * (disjoint 불변식), 그 덕에 `AgentUsageService.getLongTermUsageStats()`가
 * 임의의 UTC-day 구간에 대해 이 테이블 + live 테이블을 이중집계·gap 없이
 * 합산할 수 있다 — 구간이 day-aligned여야 하는 이유는 그 메서드의 docstring
 * 참고.
 *
 * grain에 `agent_id`를 포함(`board_id`/`ticket_id`는 제외 — planner 판단,
 * 8d5c6f5d): 롤업에서 뺀 차원은 원본 row가 reap된 후엔 복구 불가능하므로,
 * "어느 agent인가"(agent별 usage를 다루는 테이블 이름 자체가 가리키는 자연스러운
 * 첫 질문)는 남기고, 티켓/보드별 세분화는 카디널리티 대비 실효용이 낮아
 * live-window 전용(`TokenUsageStats`의 `top_tickets`)으로 남긴다.
 *
 * `agent_id`는 의도적으로 FK가 없다 — agent 레코드 자체가 삭제된 뒤에도 usage
 * 히스토리는 살아남아야 한다.
 *
 * 컬럼 타입은 `Subagent`의 usage 컬럼과 동일하게 `int`/`float`이고 `bigint`가
 * 아니다: 한 행은 최대 "하루 · agent 1개"분만 담으므로 int32(~21억) 상한이
 * per-row 기준으로는 현실적 우려가 아니다. all-time 누적은 여러 행을 조회
 * 시점에 `SUM()`으로 합산하는데, 이는 `Subagent.input_tokens`를
 * `getTokenUsageStats`가 이미 같은 방식으로 SUM()하는 것과 동일하다(pg는
 * SUM(int) 결과를 문자열로 반환 — 호출부는 동일한 `num()` 헬퍼로 coercion).
 *
 * 네 토큰 컬럼 중 여유가 가장 적은 건 `cache_read_input_tokens`다(요청 1건이
 * 큰 캐시 컨텍스트를 정당하게 재-read할 수 있고, 바쁜 agent는 하루 수천 건도
 * 가능) — 현재 규모에선 충분히 여유롭지만 지켜봐야 할 컬럼. Escape hatch:
 * `_sweepEnded`의 rollup upsert가 Postgres "integer out of range" 에러를
 * 로그에 남기면, 그게 바로 해당 컬럼을 `bigint`로 승격할 시점이라는 신호다 —
 * D-01 auto-DDL이 무손실 ALTER로 적용하므로 마이그레이션 불요. 이 실패
 * 모드는 시끄럽고 완전히 복구 가능하다(트랜잭션 롤백, 원본 row 보존, 다음
 * sweep tick이 재시도) — bigint-as-string의 조용한 오염과 정반대이며, 그래서
 * `int`가 더 가벼운 선택일 뿐 아니라 더 안전한 기본값이다. 이 오버플로는
 * Postgres 전용이라는 점도 참고: sqlite의 INTEGER는 8바이트라 dev/test:qa
 * 에서는 절대 재현되지 않는다 — 탐지 경로는 테스트가 아니라 sweep 로그다.
 */
@Entity('agent_usage_daily_rollups')
@Unique('uq_agent_usage_rollup_ws_date_agent', ['workspace_id', 'usage_date', 'agent_id'])
@Index(['workspace_id', 'usage_date'])
export class AgentUsageDailyRollup {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  workspace_id: string;

  // 롤업된 run들의 `started_at`이 속하는 UTC 달력 날짜, 'YYYY-MM-DD'.
  // `date` 컬럼이 아니라 plain varchar인 이유: sqlite엔 애초에 네이티브 date
  // 타입이 없고, ISO 문자열은 두 dialect 모두 텍스트로 정렬/비교가 정확하며,
  // 이 값은 어차피 문자열 키로만 읽으므로 드라이버별 Date-vs-string 반환
  // 형태 차이를 아예 피할 수 있다.
  @Column({ type: 'varchar' })
  usage_date: string;

  @Column({ type: 'varchar' })
  agent_id: string;

  @Column({ type: 'int', default: 0 })
  runs_total: number;

  // TokenUsageStats.coverage와 동일한 "계측됨" 커버리지 지표 —
  // 롤업 시점에 input_tokens가 non-null이었던 row 수를 센다.
  @Column({ type: 'int', default: 0 })
  runs_with_usage: number;

  @Column({ type: 'int', default: 0 })
  priced_runs: number;

  @Column({ type: 'int', default: 0 })
  input_tokens: number;

  @Column({ type: 'int', default: 0 })
  output_tokens: number;

  @Column({ type: 'int', default: 0 })
  cache_read_input_tokens: number;

  @Column({ type: 'int', default: 0 })
  cache_creation_input_tokens: number;

  @Column({ type: 'float', default: 0 })
  total_cost_usd: number;

  @CreateDateColumn()
  created_at: Date;

  // sweep tick이 기존 행에 usage를 더 접어 넣을 때마다 갱신된다(같은 날짜가
  // 여러 tick에 걸쳐 조금씩 retention을 넘기는 run들로부터 기여를 받을 수
  // 있으므로).
  @UpdateDateColumn()
  updated_at: Date;
}
