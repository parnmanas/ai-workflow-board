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
/**
 * `(mission_id, write_seq)` 에 UNIQUE 제약을 **의도적으로 걸지 않는다** (티켓 7396f93d).
 *
 * **정상 채번 경로의 양수 `write_seq` 유일성**은 쓰기 시점에 이미 보장된다 — `recordEvent` 가
 * 미션 row 를 잠근 트랜잭션 안에서 `MAX(write_seq) + 1` 을 확정하고(티켓 50031353), 그 이전에
 * 쌓여 있던 행은 `1760000000086-BackfillOrchestrationEventWriteSeq` 가 미션별 1..N 으로
 * 재부여했다(티켓 c17b5c2c). 회귀는 sqljs·Postgres 양쪽 실드라이버 동시성 테스트가 잡는다.
 * 아래 fail-open 이 남기는 `write_seq = 0` 행은 **이 보장 밖이다** — 0 은 "순서 미상" 이라
 * 애초에 순서를 주장하지 않는 값이고, 같은 미션에 여러 개 생길 수 있다.
 *
 * 그래서 제약은 **이미 성립하는 범위를 한 번 더 덮을 뿐이고, 남은 위반 경로에는 형태별로 다르게
 * 빗나간다.** `recordEvent` 는 정렬 키 유도가 실패해도 `write_seq: 0` 으로 타임라인 행을 남기는데,
 * 한 미션에서 이 fail-open 이 두 번 일어나면 0 이 두 행이 된다. 그때:
 *
 * - **전체 UNIQUE** 는 두 번째 0 INSERT 를 거부하고, 그 예외를 맨 안쪽 catch 가 삼켜 **감사 행이
 *   통째로 사라진다.** 순서가 복구되는 게 아니라 조용한 degrade 가 조용한 유실로 바뀐다.
 * - **`write_seq <> 0` 부분 인덱스** 는 0 이 인덱스 밖이라 그 INSERT 를 **거부하지 않는다** —
 *   유실은 만들지 않지만 0 중복과 그로 인한 커서 건너뜀을 그대로 둔다. 즉 이 경로에 대해
 *   아무것도 하지 않는다. 그러면서도 백필 전 **양수** 레거시 중복(seq=1 군집, 티켓 85efcb69
 *   증상)에는 그대로 걸려 아래의 부팅 실패는 피하지 못한다.
 *
 * 반대편 비용은 크다. `db.ts` 의 `synchronize` 는 모든 분기에서 하드코딩 on 이고(D-01)
 * `runMigrations()` 는 `DataSource.initialize()` **뒤에** 돈다(D-02, `database.module.ts`).
 * 따라서 백필을 아직 돌리지 않은 DB 가 제약이 든 빌드로 곧장 올라오면, 백필이 한 줄도 돌기
 * 전에 `CREATE UNIQUE INDEX` 를 맞아 **부팅 자체가 실패한다** — 백필이 같은 빌드에 들어
 * 있어도 마찬가지다. 백필 포함 빌드를 한 번 부팅해야만 안전해지는데 자가 호스팅 설치본과
 * 개발자 로컬 `data.db` 에 그 순서를 강제할 수단이 없다. 타임라인 커서가 페이지 경계에서
 * 이벤트를 건너뛸 수 있는 위험과 서버가 아예 뜨지 못하는 위험은 교환 대상이 아니다.
 *
 * 다시 검토한다면 제약만 얹지 말고, `dispatch_intents` 처럼 synchronize **이전에** 도는
 * 복구 훅(`db.ts` 의 `preSyncPostgres` / `preSyncSqljsOpenIntents`, 티켓 3c3b17a3)을 함께
 * 설계할 것. 그리고 fail-open 채번을 먼저 유일값으로 바꿔야 한다 — 그러지 않으면 전체 UNIQUE 는
 * 위 유실 경로를, 부분 인덱스는 0 중복과 커서 건너뜀을 그대로 남긴다.
 */
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
