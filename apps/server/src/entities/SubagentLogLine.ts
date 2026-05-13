import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { Subagent } from './Subagent';

/**
 * One stream-json line forwarded by the plugin. Always retrieved ordered by
 * (subagent_id, seq) so the UI replays lines in arrival order even when ts
 * timestamps tie at millisecond resolution.
 *
 * Cascade delete: when the parent Subagent row is reaped by the retention
 * sweep, TypeORM emits the FK with onDelete: 'CASCADE' so this row dies too.
 * Both Postgres and SQLite enforce this through the generated FK; no manual
 * sweep over orphan lines is required.
 */
@Entity('subagent_log_lines')
@Index(['subagent_id', 'seq'])
export class SubagentLogLine {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // FK to subagents.subagent_id. Kept as varchar because the Subagent PK
  // itself is varchar (plugin-generated UUIDs stored as plain strings, no
  // server-side uuid validation enforced). Widening here without also
  // widening the PK would break referential integrity, and there's no SQL
  // JOIN against this column that hits the PG operator-mismatch path.
  @Column({ type: 'varchar' })
  subagent_id: string;

  // Monotonic per-subagent sequence — set by SubagentMonitorService.appendLines
  // off the parent's line_count, so lines stay ordered without depending on the
  // log-line table's auto-increment.
  @Column({ type: 'int' })
  seq: number;

  // 'in' | 'out'
  @Column({ type: 'varchar' })
  direction: string;

  @Column({ type: 'text' })
  line: string;

  @Column({ type: Date })
  ts: Date;

  @ManyToOne(() => Subagent, (sa) => sa.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'subagent_id', referencedColumnName: 'subagent_id' })
  subagent: Subagent;
}
