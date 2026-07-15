import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, OneToMany, JoinColumn } from 'typeorm';
import { Board } from './Board';
import { Ticket } from './Ticket';

/**
 * Workflow classification a column plays in the lifecycle. Data-driven
 * substitute for hard-coded column-name string compares.
 *
 *   - 'intake':   pre-active queue (e.g. Backlog). BacklogPromotionService
 *                 picks tickets here and moves them into the next 'active'
 *                 column when capacity opens up.
 *   - 'active':   work-in-progress columns (To Do / Plan / In Progress).
 *                 Tickets here count toward agent capacity caps.
 *   - 'review':   review / approval gate (Review). Functionally an 'active'
 *                 column but tagged so promotion / supervisor heuristics
 *                 can treat it differently if needed.
 *   - 'merging':  post-review merge step. Same.
 *   - 'terminal': end-state (Done). is_terminal=true is kept as a parallel
 *                 boolean for backward compatibility; this enum is the
 *                 forward-going classification.
 *   - '':         unset / legacy. Treated as 'active' at runtime.
 */
export type ColumnKind =
  | ''
  | 'intake'
  | 'active'
  | 'review'
  | 'merging'
  | 'terminal';

export type UnassignedColumnPolicy = 'halt' | 'skip' | 'skip_if_ticket_staffed';

@Entity('columns')
export class BoardColumn {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', nullable: true, default: '' })
  workspace_id: string;

  @Column({ type: 'varchar' })
  board_id: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'int' })
  position: number;

  @Column({ type: 'varchar', default: '#e2e8f0' })
  color: string;

  @Column({ type: 'varchar', default: '' })
  description: string;

  @Column({ type: 'boolean', default: false })
  is_terminal: boolean;

  /**
   * Data-driven workflow kind. See ColumnKind for the value space. This is
   * the single source of truth used by runtime dispatch; the previous
   * approach of comparing `col.name.toLowerCase()` against literal strings
   * like `'backlog'` / `'review'` is forbidden in apps/server/src.
   *
   * Backfilled by 1760000000016 from is_terminal + position + name.
   * New columns default to '' which runtime treats as 'active'.
   */
  @Column({ type: 'varchar', default: '' })
  kind: ColumnKind;

  /**
   * Per-column role-slug routing. JSON array of WorkspaceRole.slug values
   * (e.g. `["assignee","reviewer"]`). When a ticket lands on this column
   * the listed roles get triggered.
   *
   * Replaces the previous `Board.routing_config` lookup keyed by
   * lowercased column name (which forced a name-match every dispatch).
   * `Board.routing_config` remains as the legacy edit surface — UI mutations
   * are written through to per-column `role_routing` so the runtime path
   * never reads the lowercased name.
   *
   * Empty `'[]'` → no triggers from this column. Backfilled by
   * 1760000000016 from the parent board's routing_config.
   */
  @Column({ type: 'text', default: '[]' })
  role_routing: string;

  /** What to do when none of this column's routed roles has a holder. */
  @Column({ type: 'varchar', default: 'halt' })
  unassigned_policy: UnassignedColumnPolicy;

  @CreateDateColumn()
  created_at: Date;

  @ManyToOne(() => Board, board => board.columns, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'board_id' })
  board: Board;

  @OneToMany(() => Ticket, ticket => ticket.column, { cascade: true })
  tickets: Ticket[];
}
