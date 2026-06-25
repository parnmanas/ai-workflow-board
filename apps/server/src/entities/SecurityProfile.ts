import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

/**
 * SecurityProfile — a reusable security-inspection definition.
 *
 * The security-inspection feature is the QA scenario subsystem's sibling
 * (QaScenario/QaRun), built for the same ChatRoom dispatch + reaper + artifact
 * pipeline, but modelling a *security review* instead of a step-based QA flow:
 *
 *   - a QaScenario carries an ordered `steps[]`; a SecurityProfile carries a
 *     `checklist[]` of things to look for (OWASP/authz/secrets/input-validation…)
 *     and a `scan_driver` (code-review / dependency / secrets / custom).
 *   - a QaRun records pass/fail per step; a SecurityRun records a `findings[]`
 *     list with severities.
 *   - the run input is not "do these steps" but "inspect the changed code since
 *     the last passing inspection (incremental) or the whole codebase (full)".
 *
 * The incremental-scoping mechanism lives here: `scope_mode` (default
 * 'incremental') + `last_passed_commit` (the HEAD SHA of the most recent PASS
 * run). When a run passes, completeRun advances `last_passed_commit` to that
 * run's scanned commit, so the next incremental run only diffs
 * `last_passed_commit..HEAD`. The server stores/forwards the baseline SHA only —
 * the agent runs `git diff` itself inside its worktree (the server has no local
 * clone; git-branches.ts is ls-remote only).
 *
 * JSON columns use TypeORM `simple-json` (same pattern as QaScenario.steps /
 * Agent.role_prompt_meta) so they serialize/deserialize automatically. The JSON
 * projection (securityProfileToJson) still coalesces null → [] so older rows
 * render cleanly.
 */
@Entity('security_profiles')
export class SecurityProfile {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  workspace_id: string;

  // null = workspace-scoped (applies to any board); <uuid> = pinned to a board.
  @Column({ type: 'varchar', nullable: true, default: null })
  board_id: string | null;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar', default: '' })
  description: string;

  // The checklist the inspection applies — each item is a thing to look for.
  // Items: { id, title, category, severity_hint?, guidance? }. Rendered into the
  // run prompt and referenced back from findings via checklist_item_id.
  @Column({ type: 'simple-json', nullable: true, default: null })
  checklist: SecurityChecklistItem[] | null;

  // The agent that runs this inspection (dispatched via ChatRoom, like QA).
  @Column({ type: 'varchar' })
  target_agent_id: string;

  // The repo Resource to inspect. null = AWB's own codebase (the agent's own
  // worktree). A non-null Resource id points the agent at a checked-out repo.
  @Column({ type: 'varchar', nullable: true, default: null })
  target_resource_id: string | null;

  // Which inspection driver/lens runs, e.g. 'code-review', 'dependency',
  // 'secrets'. Free-text so new drivers don't require a schema change.
  @Column({ type: 'varchar', default: 'code-review' })
  scan_driver: string;

  // Driver-specific config (paths to include/exclude, ruleset, manifest globs…).
  @Column({ type: 'simple-json', nullable: true, default: null })
  scan_driver_config: Record<string, any> | null;

  // 'incremental' = diff last_passed_commit..HEAD first (promote to full if a
  // change touches a security-sensitive area or there is no baseline);
  // 'full' = always inspect the whole codebase.
  @Column({ type: 'varchar', default: 'incremental' })
  scope_mode: SecurityScopeMode;

  // HEAD SHA of the most recent PASS run — the baseline for the next incremental
  // run. null until the first run passes. Advanced by completeRun(status=passed).
  @Column({ type: 'varchar', nullable: true, default: null })
  last_passed_commit: string | null;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column({ type: 'simple-json', nullable: true, default: null })
  tags: string[] | null;

  // FIFO Run budget — keep at most this many SecurityRun rooms per profile.
  @Column({ type: 'int', default: 20 })
  max_runs: number;

  // On-failure auto-ticket policy (severity-gated). null/omitted = disabled.
  // When a run finishes failed/error AND carries a finding at or above
  // `min_severity` (default 'high'), completeRun files a fix ticket. Sibling of
  // QaScenario.on_failure_ticket, plus the severity gate. See
  // SecurityFailureTicketService.
  @Column({ type: 'simple-json', nullable: true, default: null })
  on_failure_ticket: SecurityOnFailureTicketConfig | null;

  @Column({ type: 'varchar', default: '' })
  created_by: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}

export type SecurityScopeMode = 'incremental' | 'full';

export interface SecurityChecklistItem {
  /** Stable id within the profile — findings reference it via checklist_item_id. */
  id: string;
  title: string;
  /** Grouping label, e.g. 'authz', 'input-validation', 'secrets', 'crypto'. */
  category?: string;
  /** Hint for the worst-case severity this item maps to (advisory, not binding). */
  severity_hint?: SecuritySeverity;
  /** Free-text guidance on how to check this item. */
  guidance?: string;
  /**
   * Evidence link backing the item — an OWASP/CWE reference URL, a CVE/GHSA id,
   * or an advisory URL. Populated by the `refresh_security_checklist` flow (the
   * agent WebSearches current guidance and stamps the source it pulled the item
   * from) and by the curated baseline seed. Free-text so either a bare id
   * (`CVE-2024-1234`, `GHSA-xxxx`) or a full URL is acceptable.
   */
  source?: string;
  /**
   * ISO-8601 timestamp of when this item entered the checklist. Stamped server
   * side at normalize time when omitted (preserved if the caller supplied one),
   * so the freshness of a security checklist is always answerable — newly
   * refreshed items carry a recent `added_at`, curated baseline items their seed
   * time.
   */
  added_at?: string;
}

export type SecuritySeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/**
 * On-failure auto-ticket policy for a SecurityProfile. Sibling of
 * QaOnFailureTicketConfig with one extra knob: `min_severity` — the severity
 * gate. A failed/errored run only files a ticket when it carries at least one
 * finding at or above this severity; runs whose worst finding is below it are
 * left as a run summary only (no ticket). Default 'high' → only critical/high
 * findings escalate to a ticket.
 */
export interface SecurityOnFailureTicketConfig {
  enabled: boolean;
  /** Board to file on. Falls back to run.board_id → profile.board_id. */
  board_id?: string;
  /** Target column (default 'To Do' → first non-terminal → first column). */
  column_name?: string;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  /** Assignee for the fix ticket; falls back to the profile's target agent. */
  assignee_id?: string;
  labels?: string[];
  /**
   * Severity gate. A ticket is filed only if the run has a finding whose
   * severity is >= this. Default 'high' (critical/high escalate; medium/low/info
   * do not). Severity order: critical > high > medium > low > info.
   */
  min_severity?: SecuritySeverity;
  // 'per_run'         — one ticket per failed run (default; the run-level
  //                     auto_ticket_id guard already stops a re-finalize from
  //                     double-filing).
  // 'per_open_ticket' — if an open security ticket for this profile already
  //                     exists, append a recurrence comment instead of filing
  //                     a new one.
  dedupe?: 'per_run' | 'per_open_ticket';
  // Optional title override. `{{profile.name}}` is substituted. Default
  // '보안 점검 실패: {{profile.name}}'.
  title_template?: string;
}
