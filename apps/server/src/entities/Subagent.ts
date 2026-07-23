import { Entity, PrimaryColumn, Column, CreateDateColumn, OneToMany, Index } from 'typeorm';
import { SubagentLogLine } from './SubagentLogLine';

/**
 * Persistent record of a plugin-spawned subagent. Replaces the previous
 * in-memory registry so transcripts survive server restarts and the per-row
 * `expires_at` fence drives a single sweep that reaps both rows and lines.
 *
 * Lifecycle:
 *   - register POST  → INSERT (ended_at = null, expires_at = null)
 *   - line POSTs     → INSERT into subagent_log_lines, line_count++
 *   - end POST       → UPDATE ended_at + exit_code + signal + duration_ms +
 *                      optional usage (input/output/cache tokens, cost,
 *                      model — ticket 6dd3f968, validated/clamped in
 *                      SubagentMonitorService.end), expires_at = now + retentionMs
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
// Ticket ef53fdf4's hard-budget token gate runs countWindowTokens on EVERY
// dispatch attempt (not a 15s poll like AgentUsageService), filtering by
// ticket_id + started_at — index it so a busy workspace's subagents table
// doesn't force a full scan on that hot path.
@Index(['ticket_id', 'started_at'])
export class Subagent {
  // Plugin-generated UUID; not server-generated. Stored as varchar to match the
  // project-wide convention of plain string IDs (no FK metadata required).
  @PrimaryColumn({ type: 'varchar' })
  subagent_id: string;

  @Column({ type: 'varchar' })
  agent_id: string;

  @Column({ type: 'varchar' })
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

  @Column({ type: 'varchar', nullable: true, default: null })
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

  // Token/cost usage (ticket 6dd3f968) — populated from the `end` POST body
  // when the agent-manager's adapter layer could extract a `CliUsageSnapshot`
  // (Claude/DeepSeek/Codex; null for Antigravity and any pre-6dd3f968 manager
  // build that doesn't send `usage` at all). Nullable rather than 0 so
  // aggregation can tell "reported zero" apart from "never instrumented".
  @Column({ type: 'int', nullable: true, default: null })
  input_tokens: number | null;

  @Column({ type: 'int', nullable: true, default: null })
  output_tokens: number | null;

  @Column({ type: 'int', nullable: true, default: null })
  cache_read_input_tokens: number | null;

  @Column({ type: 'int', nullable: true, default: null })
  cache_creation_input_tokens: number | null;

  @Column({ type: 'float', nullable: true, default: null })
  total_cost_usd: number | null;

  // Best-effort model attribution — the spawn's resolved `--model` value when
  // known (harness/effort/agent-default precedence already resolved it before
  // spawn), independent of whether numeric usage was captured.
  @Column({ type: 'varchar', nullable: true, default: null })
  usage_model: string | null;

  @CreateDateColumn()
  created_at: Date;

  @OneToMany(() => SubagentLogLine, (line) => line.subagent)
  lines: SubagentLogLine[];
}
