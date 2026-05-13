import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, VersionColumn, ManyToOne, OneToMany, JoinColumn } from 'typeorm';
import { BoardColumn } from './BoardColumn';
import { Comment } from './Comment';
import { emptyToNullUuid, nullablePassThroughUuid } from '../database/uuid-column';

@Entity('tickets')
export class Ticket {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // FK to workspaces.id. v1 stored '' as the "unassigned" sentinel; the
  // transformer collapses '' ↔ NULL so consumer code can keep using ''.
  @Column({ type: 'uuid', nullable: true, transformer: emptyToNullUuid })
  workspace_id: string;

  // FK to columns.id (uuid). Typed `uuid` so PG joins like
  // `c.id = t.column_id` (see AgentWorkloadService.getWorkflowLoadTicketIds)
  // don't blow up with `operator does not exist: character varying = uuid`.
  // database/pre-sync-postgres.ts handles the in-place widening on first boot.
  @Column({ type: 'uuid', nullable: true })
  column_id: string;

  @Column({ type: 'uuid', nullable: true, transformer: nullablePassThroughUuid })
  parent_id: string | null;

  @Column({ type: 'int', default: 0 })
  depth: number;

  @Column({ type: 'varchar' })
  title: string;

  @Column({ type: 'varchar', default: '' })
  description: string;

  @Column({ type: 'text', default: '' })
  prompt_text: string;

  @Column({ type: 'varchar', default: 'medium' })
  priority: string;

  @Column({ type: 'varchar', default: '' })
  assignee: string;

  @Column({ type: 'varchar', default: '' })
  reporter: string;

  // Legacy v1 holder ids — TicketRoleAssignment is the source of truth post
  // v0.34, but these columns linger as denorm cache for fast list reads.
  // Widened to uuid so PG joins / writes from caller code that supplies a
  // valid uuid (or '' for unset) stop tripping the varchar = uuid operator.
  @Column({ type: 'uuid', nullable: true, transformer: emptyToNullUuid })
  assignee_id: string;

  @Column({ type: 'uuid', nullable: true, transformer: emptyToNullUuid })
  reporter_id: string;

  @Column({ type: 'uuid', nullable: true, transformer: emptyToNullUuid })
  reviewer_id: string;

  @Column({ type: 'uuid', nullable: true, transformer: nullablePassThroughUuid })
  locked_by_agent_id: string | null;

  @Column({ type: Date, nullable: true, default: null })
  locked_at: Date | null;

  @VersionColumn({ default: 1 })
  version: number;

  @Column({ type: 'varchar', default: '[]' })
  labels: string;

  @Column({ type: 'varchar', default: '[]' })
  channel_ids: string;

  @Column({ type: 'int', default: 0 })
  position: number;

  @Column({ type: 'varchar', default: 'todo' })
  status: string;

  // Repository resource the ticket builds against. Empty when the ticket is
  // pure-discussion / non-code. UI sources the picker from workspace+board
  // resources of type='repository'; the agent uses this id (plus base_branch)
  // to locate the clone URL and pull the latest before branching.
  @Column({ type: 'uuid', nullable: true, transformer: emptyToNullUuid })
  base_repo_resource_id: string;

  // Branch the agent should treat as the base when starting work — the feature
  // branch is cut from this. Empty falls back to the repository's default
  // branch (Resource.default_branch, then origin/HEAD).
  @Column({ type: 'varchar', default: '' })
  base_branch: string;

  // Optional pointer to the next ticket the team wants picked up automatically
  // once this one finishes. When this ticket lands on a terminal column,
  // TriggerLoopService dispatches a `trigger_source: 'next_ticket'` round
  // for the linked ticket's current column's routing roles. Same-workspace +
  // no-self-link guarded at write time. Empty / null disables the chain.
  @Column({ type: 'uuid', nullable: true, transformer: nullablePassThroughUuid })
  next_ticket_id: string | null;

  @Column({ type: 'varchar', default: '' })
  created_by: string;

  @Column({ type: 'varchar', default: '' })
  created_by_type: string; // 'user' | 'agent'

  @Column({ type: 'uuid', nullable: true, transformer: emptyToNullUuid })
  created_by_id: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => BoardColumn, col => col.tickets, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'column_id' })
  column: BoardColumn;

  @ManyToOne(() => Ticket, ticket => ticket.children, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'parent_id' })
  parent: Ticket | null;

  @OneToMany(() => Ticket, ticket => ticket.parent, { cascade: true })
  children: Ticket[];

  @OneToMany(() => Comment, comment => comment.ticket, { cascade: true })
  comments: Comment[];
}
