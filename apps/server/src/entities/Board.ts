import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany, ManyToOne, JoinColumn } from 'typeorm';
import { BoardColumn } from './BoardColumn';
import { Workspace } from './Workspace';
import { emptyToNullUuid } from '../database/uuid-column';

@Entity('boards')
export class Board {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true, transformer: emptyToNullUuid })
  workspace_id: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar', default: '' })
  description: string;

  @Column({ type: 'varchar', default: '{}' })
  routing_config: string;  // JSON: { [columnName: string]: string[] }  e.g. { "review": ["assignee","reviewer"] }
                           // Keyed by lowercase column name. Each value is an array of roles to notify.

  @Column({ type: 'text', nullable: true, default: null })
  column_prompts: string | null;  // JSON: { [columnId: string]: promptTemplateId: string }
                                  // Keyed by BoardColumn.id. Template content is attached to agent_trigger SSE events
                                  // when a ticket moves into the mapped column.

  // Per-board cap on how many distinct tickets a single agent can be
  // actively working on at once. Default 1 — same agent assigned to
  // multiple tickets would otherwise have parallel subagents stomping on
  // the same working_dir (git index, build artefacts, etc.). Tighter
  // boards bumping this to 2+ trade local-repo safety for throughput;
  // loose boards (e.g. read-only review queues) can set it higher
  // freely. Server-side trigger emission and manager-side dispatch
  // both honor this — server skips out-of-cap triggers with an activity
  // log entry, manager keeps a defensive drop in case two triggers
  // raced past the server gate.
  @Column({ type: 'int', default: 1 })
  max_concurrent_tickets_per_agent: number;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @Column({ type: Date, nullable: true, default: null })
  archived_at: Date | null;

  // Board-wide soft pause. When non-null, every trigger emission for tickets
  // on this board is dropped (TriggerLoopService._emitTrigger checks this as
  // the first gate, covering activity-driven, supervisor, backlog-promotion,
  // and manual paths since they all funnel through that single chokepoint).
  // BacklogPromotionService.tryPromote also short-circuits so paused boards
  // don't silently shuffle tickets out of intake. The board UI still works
  // — humans can read, comment, drag tickets — only agent wake-ups stop.
  // Resume by clearing back to null. Mirrors the archived_at soft-flag
  // pattern: nullable timestamp, ISO date = paused-since.
  @Column({ type: Date, nullable: true, default: null })
  paused_at: Date | null;

  @ManyToOne(() => Workspace, ws => ws.boards, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'workspace_id' })
  workspace: Workspace;

  @OneToMany(() => BoardColumn, col => col.board, { cascade: true, eager: true })
  columns: BoardColumn[];
}
