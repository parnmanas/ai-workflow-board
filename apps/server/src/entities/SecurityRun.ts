import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';
import type { SecuritySeverity, SecurityScopeMode } from './SecurityProfile';

/**
 * SecurityRun — one execution of a SecurityProfile.
 *
 * Mirrors QaRun (profile_id ↔ scenario_id, room_id is the dispatch vehicle) and
 * swaps the step model for a finding model: a `findings[]` accumulation, each
 * with a severity, plus the incremental-scope bookkeeping
 * (`scanned_commit` / `baseline_commit` / `scope_used`).
 *
 * Lifecycle: pending → running → passed | failed | error. Created with
 * status='running' at dispatch; only the agent (complete_security_run) or the
 * reaper (stale → error) stamps a terminal status. Re-running a profile inserts
 * another SecurityRun, so history is preserved (FIFO-capped at max_runs).
 *
 * Commit bookkeeping:
 *   - baseline_commit: the SHA this run diffs against. Set at dispatch from the
 *     profile's last_passed_commit when scope is incremental; null for a full
 *     scan (no baseline).
 *   - scanned_commit: the worktree HEAD SHA the agent actually inspected.
 *     Reported by the agent at completion (the server can't resolve it — no
 *     local clone). On a PASS this becomes the profile's new last_passed_commit.
 *   - scope_used: 'incremental' or 'full' — the scope the run actually used. The
 *     server pre-sets it at dispatch, but the agent may promote
 *     incremental → full (sensitive change / missing baseline) and reports the
 *     real value back.
 */
@Entity('security_runs')
@Index(['profile_id', 'created_at'])
export class SecurityRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  profile_id: string;

  @Column({ type: 'varchar' })
  workspace_id: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  board_id: string | null;

  // pending → running → passed | failed | error
  @Column({ type: 'varchar', default: 'pending' })
  status: SecurityRunStatus;

  // ChatRoom the inspection agent runs in (existing chat dispatch infra).
  @Column({ type: 'varchar', default: '' })
  room_id: string;

  // Accumulated findings. Each: { id, severity, title, category, file?, line?,
  // evidence?, remediation?, checklist_item_id? }.
  @Column({ type: 'simple-json', nullable: true, default: null })
  findings: SecurityFinding[] | null;

  // The worktree HEAD SHA this run inspected (reported by the agent).
  @Column({ type: 'varchar', default: '' })
  scanned_commit: string;

  // The baseline SHA this run diffed against; null for a full scan.
  @Column({ type: 'varchar', nullable: true, default: null })
  baseline_commit: string | null;

  // The scope the run actually used.
  @Column({ type: 'varchar', default: 'full' })
  scope_used: SecurityScopeMode;

  // Flat accumulation of artifact Resource ids (reports/SBOM/dumps) for this run.
  @Column({ type: 'simple-json', nullable: true, default: null })
  artifact_resource_ids: string[] | null;

  @Column({ type: 'text', default: '' })
  summary: string;

  @Column({ type: 'varchar', default: 'user' })
  triggered_by_type: string;

  @Column({ type: 'varchar', default: '' })
  triggered_by_id: string;

  @Column({ type: Date, nullable: true, default: null })
  started_at: Date | null;

  @Column({ type: Date, nullable: true, default: null })
  finished_at: Date | null;

  @CreateDateColumn()
  created_at: Date;
}

export type SecurityRunStatus = 'pending' | 'running' | 'passed' | 'failed' | 'error';

export interface SecurityFinding {
  /** Stable id within the run — re-recording the same id upserts (no dupes). */
  id: string;
  severity: SecuritySeverity;
  title: string;
  category?: string;
  /** Source file the finding is in, relative to the repo root. */
  file?: string;
  line?: number;
  /** Evidence: the offending snippet / a short proof note. */
  evidence?: string;
  /** Suggested remediation. */
  remediation?: string;
  /** The checklist item this finding maps back to (SecurityChecklistItem.id). */
  checklist_item_id?: string;
}
