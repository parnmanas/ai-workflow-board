import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * 랜딩 lease — Merging 단계의 "CI 검증 시작 → 랜딩" 구간을 저장소별로
 * 직렬화하는 큐 (ticket e630b530).
 *
 * 한 행이 두 가지 역할을 겸한다:
 *   - `state='held'`    — 이 티켓이 현재 그 저장소의 랜딩 구간을 독점한다.
 *   - `state='waiting'` — 대기 중. `queued_at` 오름차순이 FIFO 순서(기아 방지).
 * 해제된 행은 `released_at` 이 채워지고 감사 이력으로 남는다(삭제하지 않는다 —
 * 대기 시간·재검증 횟수·홀더 관측성이 완료 기준이다).
 *
 * ── 홀더 신원은 티켓 ID 다 (설계 보정 B) ─────────────────────────────────
 * 세션/subagent 가 아니다. lease 수명이 여러 턴 경계를 넘는다: 홀더는
 * `await_ci_run` 으로 턴을 끝내고, CI 가 해소되면 **새 세션**으로 재개돼 ff
 * push 를 한다. 세션을 신원으로 삼으면 그 재개 시점에 자기 lease 를 잃는다.
 * `holder_agent_id` 는 관측용일 뿐 상호배제 키가 아니다.
 *
 * ── 상호배제는 앱이 아니라 DB 에서 (설계 보정 C) ─────────────────────────
 * 검토 범위가 "다중 manager 상황" 을 명시하므로 인프로세스 뮤텍스는 답이 될 수
 * 없다. `uniq_merge_lease_held_scope` 부분 UNIQUE 인덱스가 유일한 중재자이고,
 * 획득은 그 인덱스를 향한 `INSERT … ON CONFLICT DO NOTHING`(`.orIgnore()`)
 * 이다 — DispatchIntent 의 `uniq_dispatch_intent_open_ticket_role` 와 정확히
 * 같은 패턴. 부분 인덱스는 sql.js(SQLite ≥ 3.8)와 Postgres 양쪽이 지원하고
 * TypeORM `synchronize`(양쪽 하드코딩 ON — db.ts D-01)가 동일 DDL 을 낸다.
 *
 * 술어에 `state = 'held'` 를 함께 넣은 이유: 대기자 행도 `released_at IS NULL`
 * 이라 그 조건만으로는 대기자끼리 충돌한다. 스코프당 홀더 1명이라는 상호배제
 * 자체는 그대로다.
 */
@Entity('merge_leases')
// 스코프당 홀더는 최대 1명. 획득의 원자성을 담보하는 유일한 장치.
@Index('uniq_merge_lease_held_scope', ['repo_resource_id', 'base_branch'], {
  unique: true,
  where: "state = 'held' AND released_at IS NULL",
})
// 티켓당 열린 행(홀더든 대기자든)은 최대 1개 — 재진입 획득이 대기 행을 중복
// 생성하지 않게 한다.
@Index('uniq_merge_lease_open_ticket', ['ticket_id'], { unique: true, where: 'released_at IS NULL' })
// 리퍼/부여 스윕의 핫 쿼리: 스코프별 열린 행을 FIFO 로 훑는다.
@Index('idx_merge_leases_scope_open', ['repo_resource_id', 'base_branch', 'state', 'queued_at'])
export class MergeLease {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', default: '' })
  workspace_id: string;

  @Column({ type: 'varchar', default: '' })
  board_id: string;

  // ── 스코프 키 ────────────────────────────────────────────────────────────
  // 티켓의 `base_repo_resource_id`(없으면 보드 환경 저장소)로 해석한 Resource id.
  // 둘 다 해석 못 하면 lease 자체를 만들지 않고 degraded 로 통과시킨다.
  @Column({ type: 'varchar' })
  repo_resource_id: string;

  // 같은 저장소라도 base branch 가 다르면 서로 경쟁하지 않는다.
  @Column({ type: 'varchar' })
  base_branch: string;

  // ── 홀더 신원(보정 B) ───────────────────────────────────────────────────
  @Column({ type: 'varchar' })
  ticket_id: string;

  /** 관측용. 획득을 요청한 에이전트. 상호배제 키가 아니다. */
  @Column({ type: 'varchar', default: '' })
  holder_agent_id: string;

  /** 'held' | 'waiting' — 해제되면 released_at 이 채워지고 state 는 그대로 남는다. */
  @Column({ type: 'varchar', default: 'waiting' })
  state: string;

  // ── 타임라인(관측성) ────────────────────────────────────────────────────
  /** 큐 진입 시각. FIFO 정렬 키이자 대기 시간 측정의 시작점. */
  @Column({ type: Date })
  queued_at: Date;

  @Column({ type: Date, nullable: true, default: null })
  acquired_at: Date | null;

  @Column({ type: Date, nullable: true, default: null })
  released_at: Date | null;

  /**
   * 해제 사유 — 'landed' | 'left_merging' | 'released_by_agent' |
   * 'reaped_idle' | 'reaped_max_hold' | 'wait_timeout' | 'superseded'.
   */
  @Column({ type: 'varchar', default: '' })
  release_reason: string;

  // ── liveness(보정 A) ────────────────────────────────────────────────────
  /**
   * 마지막으로 관측된 진행 시각. TTL 은 "작업 예산" 이 아니라 **liveness
   * 타임아웃**이다 — 고정 예산으로 잡으면 CI 매트릭스가 느려졌을 때 리퍼가
   * *진행 중인* 홀더의 lease 를 뺏고, 홀더는 그 사실을 모른 채 push 로 진입해
   * 없애려던 경쟁이 그대로 되살아난다.
   *
   * 홀더의 턴은 `await_ci_run` 에서 끝나므로 에이전트는 하트비트를 칠 수 없다.
   * 그래서 갱신은 **서버측**이다 — 스윕이 홀더 티켓의 진행 증거를 관측할 때마다
   * 이 값을 민다. 진행 증거:
   *   1. 미해소 CI 대기(`pending_ci_wait` + 아직 outcome 없는 `ci_wait_context`)
   *      — 서버 자신이 그 run 을 폴링 중이라는 가장 강한 증거.
   *   2. 홀더의 도구 호출(획득/갱신/재검증 기록).
   */
  @Column({ type: Date })
  last_progress_at: Date;

  /** 마지막 진행을 만든 것이 무엇인지(관측성). 예: 'acquired', 'ci_wait_active'. */
  @Column({ type: 'varchar', default: '' })
  progress_note: string;

  /**
   * 이 lease 를 쥔 채 CI 재검증을 몇 번 했는지. lease 가 있어도 외부 요인
   * (사람의 직접 push, 다른 AWB 인스턴스)으로 ff 가 실패할 수 있으므로 상한을
   * 두고 초과 시 **명시적 실패**로 바운스한다 — 완료 기준의 "유한하게 랜딩하거나
   * 명시적으로 실패한다" 를 문자 그대로 만족시키는 카운터.
   */
  @Column({ type: 'int', default: 0 })
  reverify_count: number;

  // ── fail-open 기록 ──────────────────────────────────────────────────────
  /**
   * lease 없이 진행하도록 통과시킨 경우 true. 이 기능의 안전성은 기본값이
   * 아니라 fail-open 이 담보하므로, 통과시킨 사실과 사유는 반드시 남긴다.
   */
  @Column({ type: 'boolean', default: false })
  degraded: boolean;

  @Column({ type: 'varchar', default: '' })
  degrade_reason: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
