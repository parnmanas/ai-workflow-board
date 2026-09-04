import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

/**
 * Append-only timeline of everything that happened inside a Mission.
 *
 * This is the observability surface the feature exists for: the operator's
 * question is never "what is the final status" but "what did the orchestrator
 * decide, who did it hand the work to, and where is it stuck right now". The
 * step rows carry current state; this table carries the history that produced
 * it, including the orchestrator's own reasoning as it submits/revises a plan.
 *
 * Deliberately NOT reusing ActivityLog: that table is ticket-scoped
 * (entity_type/ticket_id) and is read by the board activity feed, the stuck-
 * ticket detector, and the dispatch reconciler. Mixing a non-ticket mission
 * timeline into it would either pollute those consumers' queries or force a
 * synthetic ticket id onto every row.
 */
@Entity('orchestration_events')
@Index('idx_orch_events_mission', ['mission_id'])
@Index('idx_orch_events_created', ['created_at'])
export class OrchestrationEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  mission_id: string;

  @Column({ type: 'varchar' })
  workspace_id: string;

  /** Null for mission-level events (plan submitted, mission completed). */
  @Column({ type: 'varchar', nullable: true, default: null })
  step_id: string | null;

  /**
   * One of ORCHESTRATION_EVENT_TYPES (orchestration.constants.ts). Stored as a
   * plain varchar rather than an enum so adding a type never needs a schema
   * migration on either backend.
   */
  @Column({ type: 'varchar' })
  type: string;

  /** 'user' | 'agent' | 'system' */
  @Column({ type: 'varchar', default: 'system' })
  actor_type: string;

  @Column({ type: 'varchar', default: '' })
  actor_id: string;

  @Column({ type: 'varchar', default: '' })
  actor_name: string;

  /** Human-readable one-liner rendered in the timeline. */
  @Column({ type: 'text', default: '' })
  message: string;

  /** Type-specific extras (step_key, from/to status, counts, artifacts). */
  @Column({ type: 'simple-json', nullable: true, default: null })
  data: Record<string, any> | null;

  @CreateDateColumn()
  created_at: Date;

  /**
   * 같은 `created_at` 안에서의 삽입 순서(티켓 4d065f82, 리뷰 라운드1 P1-3).
   *
   * 커서 페이지네이션에 `created_at` 만 쓰면 같은 초/밀리초에 몰린 이벤트가 페이지
   * 경계에서 통째로 건너뛰거나 중복된다 — fan-out 한 번이면 수십 건이 같은 타임스탬프를
   * 갖는 이 테이블에서는 이론이 아니라 상시 조건이다. `(created_at, write_seq)` 를
   * keyset 커서로 써서 전순서를 만든다.
   *
   * 값은 `recordEvent` 가 쓰기 시점의 DB 상태에서 유도한다(같은 미션의 가장 최근
   * created_at 그룹 전체를 조회해 그 안의 최댓값 + 1). 프로세스-내 카운터를 쓰지 않는
   * 이유는 comment-tools.ts 의 `_comment_write_seq` 주석과 같다 — 재시작에 리셋되고,
   * sqljs 는 세컨더리 컬럼 AUTOINCREMENT DDL 에서 스키마 동기화가 깨진다.
   */
  @Column({ type: 'int', default: 0 })
  write_seq: number;
}
