import { Entity, PrimaryColumn, Column, CreateDateColumn, OneToMany, Index } from 'typeorm';
import { SubagentLogLine } from './SubagentLogLine';
import { nullablePassThroughUuid } from '../database/uuid-column';

/**
 * Persistent record of a plugin-spawned subagent. Replaces the previous
 * in-memory registry so transcripts survive server restarts and the per-row
 * `expires_at` fence drives a single sweep that reaps both rows and lines.
 *
 * Lifecycle:
 *   - register POST  → INSERT (ended_at = null, expires_at = null)
 *   - line POSTs     → INSERT into subagent_log_lines, line_count++
 *   - end POST       → UPDATE ended_at + exit_code + signal + duration_ms,
 *                      expires_at = now + retentionMs
 *   - reconcile POST → for any subagent of this agent NOT in the plugin's
 *                      live list, set ended_at + expires_at if not already.
 *                      Signal is set to 'disappeared' so the UI can tell the
 *                      two paths apart.
 *   - sweep tick     → DELETE WHERE expires_at IS NOT NULL AND expires_at < now
 *                      (CASCADE removes lines via FK in SubagentLogLine).
 */
@Entity('subagents')
@Index(['workspace_id', 'started_at'])
@Index(['agent_id'])
@Index(['expires_at'])
export class Subagent {
  // Plugin-generated UUID; not server-generated. Stored as varchar to match the
  // project-wide convention of plain string IDs (no FK metadata required).
  @PrimaryColumn({ type: 'varchar' })
  subagent_id: string;

  @Column({ type: 'uuid' })
  agent_id: string;

  @Column({ type: 'uuid' })
  workspace_id: string;

  // 'chat' | 'ticket' | 'oneshot'
  @Column({ type: 'varchar' })
  kind: string;

  @Column({ type: 'varchar', default: '' })
  session_key: string;

  @Column({ type: 'int', default: 0 })
  pid: number;

  @Column({ type: Date })
  started_at: Date;

  @Column({ type: 'varchar', nullable: true, default: null })
  label: string | null;

  @Column({ type: 'uuid', nullable: true, transformer: nullablePassThroughUuid })
  ticket_id: string | null;

  @Column({ type: 'text', nullable: true, default: null })
  ticket_title: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  role: string | null;

  @Column({ type: Date, nullable: true, default: null })
  ended_at: Date | null;

  @Column({ type: 'int', nullable: true, default: null })
  exit_code: number | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  signal: string | null;

  @Column({ type: 'int', nullable: true, default: null })
  duration_ms: number | null;

  @Column({ type: Date, nullable: true, default: null })
  expires_at: Date | null;

  @Column({ type: 'int', default: 0 })
  line_count: number;

  @CreateDateColumn()
  created_at: Date;

  @OneToMany(() => SubagentLogLine, (line) => line.subagent)
  lines: SubagentLogLine[];
}
