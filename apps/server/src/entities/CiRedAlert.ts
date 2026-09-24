import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn, UpdateDateColumn } from 'typeorm';

/**
 * CiRedAlert — dedup + delivery-state row for `CiHealthMonitorService` (ticket
 * cc1c494e). One row per (board, repo, branch, workflow) currently in a red
 * streak; the sweep consults it to decide whether the streak has already been
 * surfaced within the re-alert cooldown, and to avoid re-creating a Backlog
 * ticket for an episode still open.
 *
 * Sibling of `StuckTicketAlert` (same durable-delivery shape), but keyed by
 * the monitored CI target rather than a ticket_id — there is no ticket to key
 * off until (and unless) this row causes one to be created, so the PK here is
 * a generated uuid plus a unique composite index on the target tuple instead
 * of `StuckTicketAlert`'s `@PrimaryColumn ticket_id`.
 *
 * DURABLE DELIVERY (mirrors StuckTicketAlert / ticket e7c87517 blocker #3):
 * the row is written BEFORE the chat post is attempted, and `delivered_at` is
 * stamped ONLY after a chat post actually succeeds — a failed first delivery
 * is retried every sweep instead of silenced for a full re-alert window.
 *
 * On recovery (latest completed run green) the row is deleted, not flagged —
 * keeps the table self-pruning, same as StuckTicketAlert's unstuck path.
 */
@Entity('ci_red_alerts')
@Index('uq_ci_red_alerts_target', ['board_id', 'repo_full_name', 'branch', 'workflow_id'], { unique: true })
export class CiRedAlert {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  board_id: string;

  @Column({ type: 'varchar' })
  workspace_id: string;

  // "owner/repo" — parsed from the board environment repo's Resource.url.
  @Column({ type: 'varchar' })
  repo_full_name: string;

  @Column({ type: 'varchar' })
  branch: string;

  // GitHub workflow id, stored as text (external id — never arithmetic on it).
  @Column({ type: 'varchar' })
  workflow_id: string;

  @Column({ type: 'varchar', default: '' })
  workflow_name: string;

  @Column({ type: 'varchar', default: '' })
  first_failed_run_id: string;

  @Column({ type: 'varchar', default: '' })
  last_run_id: string;

  // `last_run_id` 가 가리키는 run 의 `created_at` (ISO 문자열 원본 그대로).
  //
  // 복구 단조성 게이트의 하한선이다 (ticket 0ef405f9): CI 를 green 으로 되돌리려면 그
  // 근거가 red 를 만든 이 run 보다 **엄격히 최신**이어야 한다. 이 값이 없으면 "최신
  // 응답의 첫 run 이 success" 라는 단발 신호 하나로 이 행이 지워지고, 그 응답이 한 번만
  // 어긋나도 실제로는 red 인 main 에 복구 알림이 나간다.
  //
  // 이 컬럼이 없던 시절에 만들어진 행은 빈 문자열이고, 그때는 게이트를 적용하지 않는다
  // (하한선 부재는 '검증 불가'가 아니라 '비교 대상 없음' — 다음 sweep 이 값을 채운다).
  @Column({ type: 'varchar', default: '' })
  last_run_at: string;

  // Consecutive red (failure|timed_out|startup_failure) completed runs ending
  // at last_run_id. Reset (row deleted) the moment the latest completed run
  // is green.
  @Column({ type: 'int', default: 0 })
  streak: number;

  // Durable delivery state — see class docstring. `null` = an alert is owed
  // but has never been delivered; the re-alert cooldown keys off this field,
  // never off a plain "last attempted" timestamp.
  @Column({ type: Date, nullable: true, default: null })
  delivered_at: Date | null;

  @Column({ type: 'int', default: 0 })
  delivery_attempts: number;

  // Backlog ticket auto-created for this episode, if CI_MONITOR_CREATE_TICKET
  // was enabled and creation succeeded. Left null when disabled or when
  // creation itself failed (chat alert still fires independently).
  @Column({ type: 'varchar', nullable: true, default: null })
  created_ticket_id: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
