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
   * @deprecated since ticket 4a6cdfd7 (WorkflowFocusSelector). The
   * per-agent dispatch queue was removed when the cap model was
   * replaced with the focus selector — triggers are now either emitted
   * immediately (focus = ticket) or dropped silently (focus ≠ ticket).
   *
   * The column is kept on the entity / REST setter / MCP setter so
   * older clients setting `dispatch_queue_depth` still get HTTP 200
   * rather than 400; a follow-up cleanup ticket can drop the column
   * after one release cycle. No runtime code reads this value.
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
