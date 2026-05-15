/**
 * ColumnRolePolicyService — resolution + label-gate evaluation for the
 * declarative column×role policy layer (ticket f886ada7). Pure-data
 * service: no schedulers, no chat-room writes — those live on
 * `StuckTicketDetectorService` and `RoomMessagingService`, which call into
 * this service for the "what does the policy say?" decision.
 *
 * Three responsibilities:
 *
 *   1. **Resolve** active policies for a (board_id, column_id) tuple. The
 *      detector hands in the column and gets back every enabled policy row
 *      whose `role_slug` is currently routed by that column.
 *
 *   2. **Match** a ticket's labels against a policy's `gate_labels` glob
 *      list (case-insensitive, supports `*` wildcard only — keep small).
 *      An intersection means "legitimate WAIT" and the violation branch is
 *      short-circuited.
 *
 *   3. **Classify** a ticket's current state against its applicable
 *      policies — returning a `PolicyEvaluation` the detector can use to
 *      decide whether to escalate from a plain stale-WAIT alert to a
 *      structured policy_violation alert.
 *
 * The service is read-only at PR #2 — write paths (admin REST) go through
 * the controller and a dedicated repository call.
 */
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { BoardColumn } from '../../entities/BoardColumn';
import { ColumnRolePolicy } from '../../entities/ColumnRolePolicy';

export interface PolicyEvaluation {
  /** Applicable enabled `expected_action='move'` policies for this column. */
  movePolicies: ColumnRolePolicy[];
  /** Gate-label patterns aggregated across all move policies. */
  gateLabels: string[];
  /** Ticket labels that matched at least one gate-label pattern. */
  matchedLabels: string[];
  /**
   * True iff there's at least one move-policy AND the matched-labels set
   * is empty. Caller still has to gate on cycle_counter ≥ max_cycles.
   */
  isViolation: boolean;
  /** Configured target column ids across the move policies (deduped). */
  targetColumnIds: string[];
  /** Role slugs across the move policies (deduped). */
  roleSlugs: string[];
  /** Minimum `max_cycles_without_progress` across move policies (default 4). */
  minCyclesThreshold: number;
}

@Injectable()
export class ColumnRolePolicyService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Look up all enabled policy rows for the given column. Returns rows
   * grouped by role_slug — the caller (stuck detector) intersects them with
   * the column's actual `role_routing` to figure out which one(s) apply.
   */
  async getPoliciesForColumn(columnId: string): Promise<ColumnRolePolicy[]> {
    if (!columnId) return [];
    const repo = this.dataSource.getRepository(ColumnRolePolicy);
    return repo.find({ where: { column_id: columnId, enabled: true } });
  }

  /**
   * Evaluate a ticket's labels against the policies in effect for its
   * current column. The detector calls this AFTER it has confirmed the
   * stale-WAIT shape (so we can skip ticket-load work here).
   *
   *   - `ticketLabels` is the parsed `Ticket.labels` array (already JSON
   *     parsed). Caller is responsible for the parse so this service stays
   *     storage-agnostic.
   *   - `column` is the ticket's BoardColumn (needs `role_routing`).
   *
   * Returns a `PolicyEvaluation` describing whether the system considers
   * this a policy violation (intent: caller still checks cycle_counter).
   */
  async evaluate(
    column: BoardColumn,
    ticketLabels: string[],
  ): Promise<PolicyEvaluation> {
    const empty: PolicyEvaluation = {
      movePolicies: [], gateLabels: [], matchedLabels: [],
      isViolation: false, targetColumnIds: [], roleSlugs: [],
      minCyclesThreshold: 4,
    };
    if (!column) return empty;
    const routedSlugs = parseRoleRouting(column.role_routing);
    if (routedSlugs.length === 0) return empty;
    const all = await this.getPoliciesForColumn(column.id);
    if (all.length === 0) return empty;
    const movePolicies = all.filter(
      p => p.expected_action === 'move' && routedSlugs.includes(p.role_slug),
    );
    if (movePolicies.length === 0) return empty;
    const gateLabels = dedupe(movePolicies.flatMap(p => parseGateLabels(p.gate_labels)));
    const matchedLabels = ticketLabels.filter(l =>
      gateLabels.some(gl => globMatch(gl, l)),
    );
    const targetColumnIds = dedupe(
      movePolicies
        .map(p => p.target_column_id)
        .filter(v => typeof v === 'string' && v.length > 0),
    );
    const roleSlugs = dedupe(movePolicies.map(p => p.role_slug));
    const minCyclesThreshold = movePolicies.reduce(
      (min, p) => Math.min(min, p.max_cycles_without_progress || 4),
      4,
    );
    return {
      movePolicies, gateLabels, matchedLabels,
      isViolation: matchedLabels.length === 0,
      targetColumnIds, roleSlugs, minCyclesThreshold,
    };
  }
}

/**
 * Glob match — supports `*` wildcard only (no `?`, `[abc]`, etc.). Case
 * insensitive on both sides.
 *
 * The grammar is intentionally tiny because the seeded default
 * (`BLOCKED-*`) is the only pattern we expect in production. Operators
 * can add literal labels or other star-globs without surprise.
 */
export function globMatch(pattern: string, label: string): boolean {
  if (!pattern || !label) return false;
  const p = pattern.toLowerCase();
  const s = label.toLowerCase();
  // Fast path for no wildcards — literal equality.
  if (!p.includes('*')) return p === s;
  // Convert pattern to anchored regex, escaping regex metachars except `*`.
  const re = new RegExp(
    '^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
  );
  return re.test(s);
}

/** Parse `BoardColumn.role_routing` (JSON-stringified string[]) defensively. */
export function parseRoleRouting(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === 'string' && s.length > 0);
  } catch {
    return [];
  }
}

/** Parse `ColumnRolePolicy.gate_labels` (JSON-stringified string[]) defensively. */
export function parseGateLabels(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === 'string' && s.length > 0);
  } catch {
    return [];
  }
}

function dedupe<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

// Exported for unit-test access without spinning up a Nest TestingModule.
export const __test__ = { globMatch, parseRoleRouting, parseGateLabels };
