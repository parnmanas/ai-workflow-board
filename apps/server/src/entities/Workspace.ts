import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany } from 'typeorm';
import { Board } from './Board';

@Entity('workspaces')
export class Workspace {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar', default: '' })
  description: string;

  // int type for SQLite compat (no native boolean in sql.js)
  @Column({ type: 'int', default: 0 })
  is_public: number; // 0=private, 1=public

  // URL-safe slug for workspace; nullable until backfill migration (Plan 02) sets defaults
  @Column({ type: 'varchar', unique: true, nullable: true })
  slug: string | null;

  // ─────────────────────────────────────────────────────────────────────
  // Trigger-loop / supervisor / dispatch-queue cadence settings
  //
  // Workspace-scoped overrides for the three magic numbers that used to
  // be hardcoded constants in TicketSupervisorService and (implicitly,
  // unbounded) in TriggerLoopService. Defaults match the historical
  // constants so an unmigrated workspace keeps the prior behaviour.
  //
  // Operators bump these via a Workspace settings PATCH (REST/MCP) when
  // they need a different cadence — e.g. lower `supervisor_resend_ms`
  // for fast-paced demos, or a deeper `dispatch_queue_depth` for boards
  // that legitimately spike past the per-agent cap.
  // ─────────────────────────────────────────────────────────────────────

  /** Time-since-last-update before TicketSupervisor considers a (agent, ticket, role) pair stale. ms. Default: 30 min. */
  @Column({ type: 'int', default: 1800000 })
  supervisor_stale_ms: number;

  /** Cooldown between supervisor force-respawn re-pushes after the first stale emit. ms. Default: 5 min. */
  @Column({ type: 'int', default: 300000 })
  supervisor_resend_ms: number;

  /**
   * Per-agent dispatch queue depth cap. When the queue is full, the
   * lowest-priority pending item is dropped (and a `queue_dropped_low_priority`
   * activity row is logged). Default: 100 — well above any realistic
   * single-agent backlog so drops are a real overload signal, not normal.
   */
  @Column({ type: 'int', default: 100 })
  dispatch_queue_depth: number;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @OneToMany(() => Board, board => board.workspace, { cascade: true, eager: true })
  boards: Board[];
}
