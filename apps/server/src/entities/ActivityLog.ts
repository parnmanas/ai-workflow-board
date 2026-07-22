import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

// Indices added in migration 1760000000027 to stop full-table scans on a
// table that grows unbounded — every column move, claim, release, comment,
// trigger emit, and backlog promotion writes one row, so on a long-running
// board the table dwarfs every other table by an order of magnitude. The
// following access patterns drove the index choice (counted via grep across
// agent-workload, stuck-ticket-detector, claim-verification, trigger-loop,
// supervisor, backlog-promotion):
//
//   - `WHERE ticket_id = ?`                            — single ticket history
//   - `WHERE ticket_id = ? ORDER BY created_at DESC`   — focus selector,
//                                                        stuck detector,
//                                                        latest-by-ticket
//   - `WHERE workspace_id = ?`                         — admin activity feed
//   - `WHERE entity_type = ? AND entity_id = ?`        — generic entity audit
//   - `WHERE actor_id = ? ORDER BY created_at`         — agent action history
//
// Each composite index leads with the equality column and trails with
// `created_at` so range scans (`WHERE ... AND created_at >= ?`) and
// ORDER-BY-DESC tail reads both walk the index in order. Without these
// every query above degenerated to a sequential scan that page-faulted
// against the NAS's spinning disk on each cold ring eviction.
//
// A fifth index was added in migration 1760000000062 for a read pattern
// introduced by ticket 3970db66 (workflow-health suppression stats):
//
//   - `WHERE action = ?`                               — respawn_storm_halted /
//                                                        respawn_twin_detected counts
//   - `WHERE action = ? GROUP BY field_changed`        — comment_pingpong_suppressed
//                                                        by-reason rollup
//
// `getSuppressionStats()` runs all three on every workflow-health dashboard
// poll (15s) — without this index each one was a full sequential scan of the
// same unbounded table described above.
//
// A sixth index was added in migration 1760000000063 for ticket 6dd3f968's
// windowed suppression-savings query (AgentUsageService.getTokenUsageStats):
//
//   - `WHERE action IN (...) AND created_at BETWEEN ? AND ?` — suppressed-
//                                                        attempts-in-window count
//
// Unlike getSuppressionStats() (lifetime-cumulative, no time bound, so
// `idx_activity_logs_action_field` alone already satisfies it), this query
// adds a created_at range that index can't serve past its leading `action`
// column — without a dedicated (action, created_at) index it degrades to an
// index-scan-then-filter over EVERY row that ever had a suppression action
// rather than just the window, on the SAME 15s-polled endpoint the P1 above
// already flagged once.
@Index('idx_activity_logs_ticket_created', ['ticket_id', 'created_at'])
@Index('idx_activity_logs_workspace_created', ['workspace_id', 'created_at'])
@Index('idx_activity_logs_entity', ['entity_type', 'entity_id', 'created_at'])
@Index('idx_activity_logs_actor_created', ['actor_id', 'created_at'])
@Index('idx_activity_logs_action_field', ['action', 'field_changed'])
@Index('idx_activity_logs_action_created', ['action', 'created_at'])
@Entity('activity_logs')
export class ActivityLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', nullable: true, default: '' })
  workspace_id: string;

  @Column({ type: 'varchar' })
  entity_type: string;

  @Column({ type: 'varchar' })
  entity_id: string;

  @Column({ type: 'varchar' })
  action: string;

  @Column({ type: 'varchar', default: '' })
  field_changed: string;

  @Column({ type: 'varchar', default: '' })
  old_value: string;

  @Column({ type: 'varchar', default: '' })
  new_value: string;

  @Column({ type: 'varchar', default: '' })
  actor_id: string;

  @Column({ type: 'varchar', default: '' })
  actor_name: string;

  @Column({ type: 'varchar', default: '' })
  ticket_id: string;

  @Column({ type: 'varchar', default: '' })
  role: string;  // agent role at time of activity (e.g. 'assignee', 'reviewer', '')

  @Column({ type: 'varchar', default: '' })
  trigger_source: string;  // 'agent_trigger' | 'manual' | ''

  @CreateDateColumn()
  created_at: Date;
}
