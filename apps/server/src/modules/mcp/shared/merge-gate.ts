/**
 * Merge/integration gate — server-side mechanical verification on the Merging
 * column boundary (ticket c806bad3).
 *
 * Merge quality was entirely prompt-driven + agent self-report, and the same
 * class of accident kept recurring (partial merge 1/6 commits → Done, review
 * against a stale base). QA already made the "trust self-report → server
 * verifies" transition with its evidence gate (0721bae6); this brings the same
 * transition to merge:
 *
 *   - Review→Merging  — reject when the feature branch is BEHIND base
 *                       (stale-base; the reviewer looked at an old diff).
 *   - Merging→Done    — reject when the feature branch still carries commits
 *                       NOT in base (partial-merge; unmerged work).
 *
 * Design mirrors the existing move guards (`review-approval-guard.ts`,
 * terminal-reopen): pure predicates + a DB/git orchestrator, composed at each
 * of the three move surfaces (MCP tool / REST / agent-api) exactly the way the
 * review-approval guard is. `force=true` bypasses it, same escape hatch.
 *
 * Availability-first (regression safety — DoD "게이트 미설정 보드는 기존 동작
 * 불변"):
 *   - The gate is OFF unless the board opts in via `merge_gate_config`
 *     (default OFF, see `common/merge-gate-config.ts`).
 *   - Every step that can't be resolved — no repo configured, SSH-only URL,
 *     feature branch not found, git error — DEGRADES TO PASS. Enabling the
 *     gate never manufactures a false block on a ticket the server cannot
 *     actually verify.
 */

import type { DataSource, EntityManager } from 'typeorm';
import { Board } from '../../../entities/Board';
import { BoardColumn } from '../../../entities/BoardColumn';
import { Comment } from '../../../entities/Comment';
import { Credential } from '../../../entities/Credential';
import { Resource } from '../../../entities/Resource';
import { Ticket } from '../../../entities/Ticket';
import { resolveGitCredential } from './git-branches';
import {
  BehindAhead,
  countBehindAhead,
  ensureRepoCache,
  GitCredential,
  listRefs,
} from './git-repo-cache';
import { ResolvedMergeGate, resolveMergeGate } from '../../../common/merge-gate-config';

type RepoScope = DataSource | EntityManager;

// ── pure transition classification ──────────────────────────────────────────
export type MergeTransition = 'review_to_merging' | 'merging_to_done';

/**
 * Classify a column move into a gated merge transition, or null when the move
 * is none of the gate's business. Data-driven on ColumnKind (never column-name
 * string compares — forbidden in apps/server/src — so it survives renames):
 *   - review → merging  = the pre-merge freshness checkpoint
 *   - merging → terminal = the merge-complete checkpoint (Done is kind=terminal)
 * Every other transition (into Review, reorders, non-merge terminals) returns
 * null and the gate stays inert.
 */
export function classifyMergeTransition(
  source: BoardColumn | null | undefined,
  dest: BoardColumn | null | undefined,
): MergeTransition | null {
  const s = (source as any)?.kind;
  const d = (dest as any)?.kind;
  if (s === 'review' && d === 'merging') return 'review_to_merging';
  if (s === 'merging' && d === 'terminal') return 'merging_to_done';
  return null;
}

// ── pure decision ───────────────────────────────────────────────────────────
export interface MergeDecision {
  blocked: boolean;
  /** Stable machine code, greppable like the other guard codes. */
  code?: 'merge_gate_stale_base' | 'merge_gate_partial_merge';
}

/**
 * Given the resolved per-board config and the {behind, ahead} counts of the
 * feature branch vs base, decide whether THIS transition is blocked. Pure — no
 * DB / git — so a unit spec can exhaust the truth table without a network.
 */
export function decideMergeGate(
  transition: MergeTransition,
  gate: ResolvedMergeGate,
  ba: BehindAhead,
): MergeDecision {
  if (transition === 'review_to_merging') {
    if (gate.require_fresh_base && ba.behind > 0) {
      return { blocked: true, code: 'merge_gate_stale_base' };
    }
  } else if (transition === 'merging_to_done') {
    if (gate.require_full_merge && ba.ahead > 0) {
      return { blocked: true, code: 'merge_gate_partial_merge' };
    }
  }
  return { blocked: false };
}

// ── feature-branch convention ────────────────────────────────────────────────
/** The `ticket/<id_short>` prefix the assignee workflow names feature branches
 *  with (`ticket/{ticket_id_short}-{slug}`). id_short = first 8 chars. */
export function featureBranchPrefix(ticketId: string): string {
  return `ticket/${(ticketId || '').slice(0, 8)}`;
}

/**
 * Pick the feature branch for a ticket from a repo's branch list by the naming
 * convention. Returns null when the convention resolves to zero branches
 * (→ unverifiable → pass). On multiple matches (a stale branch lingered next to
 * the live one) picks the lexicographically-first deterministically and lets
 * the caller log the ambiguity — a wrong pick can only ever yield a false block
 * the agent clears with `force=true`, never a false pass.
 */
export function resolveFeatureBranch(ticketId: string, branches: string[]): string | null {
  const prefix = featureBranchPrefix(ticketId);
  const matches = branches.filter((b) => b === prefix || b.startsWith(`${prefix}-`));
  if (matches.length === 0) return null;
  matches.sort((a, b) => a.localeCompare(b));
  return matches[0];
}

// ── git prober (injectable for tests) ────────────────────────────────────────
export interface MergeGateProbeInput {
  resource: Resource;
  credential: GitCredential;
  baseBranch: string;
  ticketId: string;
}

/**
 * Resolve the feature branch and compute {behind, ahead} vs base against the
 * per-Resource cache clone. Returns null on ANY unresolvable/failure condition
 * (SSH-only URL, feature branch absent, git error) — the availability-first
 * degrade. Swappable so the E2E spec can inject deterministic counts without a
 * live remote.
 */
export type MergeGateProbe = (input: MergeGateProbeInput) => Promise<BehindAhead | null>;

/**
 * Test-only override for the prober the move surfaces use. Production leaves it
 * null → the real cache-clone prober runs. An E2E spec (which boots the app
 * in-process from the same compiled module) sets a deterministic stub so the
 * block/pass paths can be driven over the real HTTP/MCP move surface without a
 * live git remote. `evaluateMergeGate` prefers an explicit `options.probe`, then
 * this override, then the default.
 */
let testProbeOverride: MergeGateProbe | null = null;
export function __setMergeGateProbeForTests(probe: MergeGateProbe | null): void {
  testProbeOverride = probe;
}

export const defaultMergeGateProbe: MergeGateProbe = async ({ resource, credential, baseBranch, ticketId }) => {
  try {
    const repoPath = await ensureRepoCache({
      resourceId: resource.id,
      url: resource.url,
      credential,
      // Always fetch fresh — a gate check right after a rebase/merge must see
      // the current remote tips, not a ≤60s-stale cache.
      forceFetch: true,
    });
    const refs = await listRefs(repoPath);
    const feature = resolveFeatureBranch(ticketId, refs.branches);
    if (!feature) return null;
    if (!refs.branches.includes(baseBranch)) return null;
    return await countBehindAhead(repoPath, baseBranch, feature);
  } catch {
    // SshUnsupportedError / GitReadError / anything else → unverifiable → pass.
    return null;
  }
};

// ── orchestrator ─────────────────────────────────────────────────────────────
export interface MergeGateResult {
  blocked: boolean;
  code?: MergeDecision['code'];
  /** One-line message for the surface's error return (MCP err / REST json). */
  message?: string;
  /** Longer structured comment body posted on block (what / why / how). */
  commentBody?: string;
  /** True when a structured block comment was actually written this call. */
  commented?: boolean;
  /** Diagnostic outcome for logging / tests. */
  outcome:
    | 'not_applicable'   // move isn't a gated transition
    | 'disabled'         // board didn't opt in
    | 'check_off'        // gate on, but this specific check is off
    | 'unresolvable'     // repo/base/feature branch/git couldn't be resolved → pass
    | 'fresh'            // resolved and the branch is clean → pass
    | 'blocked';         // resolved and the branch failed the check → block
}

const PASS = (outcome: MergeGateResult['outcome']): MergeGateResult => ({ blocked: false, outcome });

export interface EvaluateMergeGateOptions {
  /** Injectable git prober (defaults to the real cache-clone prober). */
  probe?: MergeGateProbe;
  /** When true (default), a block writes a structured comment on the ticket. */
  writeComment?: boolean;
  logger?: { warn?: (cat: string, msg: string, meta?: any) => void };
}

/**
 * Evaluate the merge gate for a Review→Merging or Merging→Done move. Returns a
 * `blocked` decision the caller turns into its surface-appropriate rejection.
 * Never throws — every failure path degrades to a pass.
 *
 * Read-only wrt the ticket move itself (it runs BEFORE the move transaction and
 * only blocks it). On a block it optionally writes ONE structured comment so
 * the next agent turn (and any human) can see what/why/how — deduped so a
 * retry loop can't spam identical comments.
 */
export async function evaluateMergeGate(
  scope: RepoScope,
  ticket: Ticket,
  sourceColumn: BoardColumn | null | undefined,
  destColumn: BoardColumn | null | undefined,
  options: EvaluateMergeGateOptions = {},
): Promise<MergeGateResult> {
  const transition = classifyMergeTransition(sourceColumn, destColumn);
  if (!transition) return PASS('not_applicable');

  // Resolve the board config off the destination column (both source and dest
  // live on the same board for a within-board move).
  const boardId = (destColumn as any)?.board_id || (sourceColumn as any)?.board_id;
  if (!boardId) return PASS('unresolvable');
  const board = await scope.getRepository(Board).findOne({ where: { id: boardId } });
  const gate = resolveMergeGate(board?.merge_gate_config ?? null);
  if (!gate.enabled) return PASS('disabled');

  // Is the specific check for THIS transition even on?
  const checkOn =
    transition === 'review_to_merging' ? gate.require_fresh_base : gate.require_full_merge;
  if (!checkOn) return PASS('check_off');

  // Resolve repo + base branch. Any gap → availability-first pass.
  if (!ticket.base_repo_resource_id || !ticket.workspace_id) return PASS('unresolvable');
  const resource = await scope.getRepository(Resource).findOne({
    where: { id: ticket.base_repo_resource_id, workspace_id: ticket.workspace_id },
  });
  if (!resource?.url) return PASS('unresolvable');
  const baseBranch = ticket.base_branch || resource.default_branch || '';
  if (!baseBranch) return PASS('unresolvable');

  let credential: GitCredential = null;
  try {
    credential = await resolveGitCredential(
      scope.getRepository(Credential),
      resource.credential_id,
      ticket.workspace_id,
    );
  } catch {
    credential = null;
  }

  const probe = options.probe ?? testProbeOverride ?? defaultMergeGateProbe;
  let ba: BehindAhead | null;
  try {
    ba = await probe({ resource, credential, baseBranch, ticketId: ticket.id });
  } catch (e) {
    options.logger?.warn?.('MergeGate', 'probe threw (degrading to pass)', {
      err: String(e), ticket_id: ticket.id,
    });
    ba = null;
  }
  if (!ba) return PASS('unresolvable');

  const decision = decideMergeGate(transition, gate, ba);
  if (!decision.blocked) return PASS('fresh');

  const feature = featureBranchPrefix(ticket.id);
  const message = buildBlockMessage(decision.code!, baseBranch, ba);
  const commentBody = buildBlockComment(decision.code!, baseBranch, feature, ba);

  let commented = false;
  if (options.writeComment !== false) {
    commented = await maybeWriteBlockComment(scope, ticket, decision.code!, commentBody, options.logger);
  }

  return { blocked: true, code: decision.code, message, commentBody, commented, outcome: 'blocked' };
}

// ── block copy (Korean, what / why / how) ────────────────────────────────────
function buildBlockMessage(
  code: NonNullable<MergeDecision['code']>,
  baseBranch: string,
  ba: BehindAhead,
): string {
  if (code === 'merge_gate_stale_base') {
    return (
      `merge_gate_stale_base — 피처 브랜치가 base(${baseBranch})보다 ${ba.behind} 커밋 뒤처져 있습니다(stale base). ` +
      `\`git rebase origin/${baseBranch}\` 후 재이동하세요. 의도적 우회는 force=true.`
    );
  }
  return (
    `merge_gate_partial_merge — 피처 브랜치에 base(${baseBranch})에 없는 커밋 ${ba.ahead}개가 남아 있습니다(부분 머지). ` +
    `전체 머지(ahead=0) 후 재이동하세요. 의도적 우회는 force=true.`
  );
}

function buildBlockComment(
  code: NonNullable<MergeDecision['code']>,
  baseBranch: string,
  featurePrefix: string,
  ba: BehindAhead,
): string {
  if (code === 'merge_gate_stale_base') {
    return [
      `🚫 **머지 게이트 — stale base 차단 (Review→Merging)**`,
      '',
      `피처 브랜치(\`${featurePrefix}-*\`)가 base \`${baseBranch}\` 보다 **${ba.behind} 커밋 뒤처져** 있습니다.`,
      `리뷰가 옛 base 기준으로 수행됐을 수 있어 최신 \`${baseBranch}\` 변경과의 상호작용을 놓칠 위험이 있어 이동을 막았습니다.`,
      '',
      `**해소 방법**`,
      '```',
      `git fetch origin`,
      `git rebase origin/${baseBranch}`,
      `git push --force-with-lease`,
      '```',
      `브랜치를 최신 base 위로 rebase 한 뒤 다시 Merging 으로 이동하세요.`,
      '',
      `_repo/브랜치 해석 실패 시 게이트는 통과합니다. 의도적으로 우회하려면 move 시 force=true._`,
    ].join('\n');
  }
  return [
    `🚫 **머지 게이트 — 부분 머지 차단 (Merging→Done)**`,
    '',
    `피처 브랜치(\`${featurePrefix}-*\`)에 base \`${baseBranch}\` 에 아직 반영되지 않은 **${ba.ahead} 커밋**이 남아 있습니다.`,
    `"여러 커밋 중 일부만 머지하고 Done" 류 사고를 막기 위해 전체 머지가 확인될 때까지 Done 이동을 거부합니다.`,
    '',
    `**해소 방법** — 남은 커밋을 base 로 전부 머지(fast-forward / refspec push)한 뒤 다시 Done 으로 이동하세요.`,
    '```',
    `git rev-list --left-right --count origin/${baseBranch}...<feature>   # ahead=0 확인`,
    '```',
    '',
    `_의도적으로 우회하려면 move 시 force=true._`,
  ].join('\n');
}

/**
 * Write ONE structured block comment, deduped: skip when the ticket's most
 * recent comment is already this gate's block comment with the same code (a
 * retry after a block). A different comment in between re-arms it. Never throws
 * — a comment-write failure must not turn a block into a crash.
 */
async function maybeWriteBlockComment(
  scope: RepoScope,
  ticket: Ticket,
  code: NonNullable<MergeDecision['code']>,
  body: string,
  logger?: EvaluateMergeGateOptions['logger'],
): Promise<boolean> {
  try {
    const commentRepo = scope.getRepository(Comment);
    const latest = await (commentRepo as any)
      .createQueryBuilder('c')
      .where('c.ticket_id = :tid', { tid: ticket.id })
      .orderBy('c.created_at', 'DESC')
      .limit(1)
      .getOne();
    if (latest && latest.author === 'MergeGate') {
      let meta: any = {};
      try { meta = JSON.parse(latest.metadata || '{}'); } catch { meta = {}; }
      if (meta?.merge_gate_code === code) return false; // dedup: identical repeat
    }
    await commentRepo.save(
      commentRepo.create({
        ticket_id: ticket.id,
        workspace_id: ticket.workspace_id || '',
        author_type: 'system',
        author_id: '',
        author: 'MergeGate',
        content: body,
        type: 'note',
        metadata: JSON.stringify({ merge_gate_code: code }),
      }),
    );
    return true;
  } catch (e) {
    logger?.warn?.('MergeGate', 'block comment write failed (continuing)', {
      err: String(e), ticket_id: ticket.id,
    });
    return false;
  }
}

/**
 * Thrown-shaped rejection mirroring ReviewApprovalRequiredError so REST /
 * agent-api surfaces can return a stable `{status, code, hint, message}`.
 * (MCP surface uses the plain `message` via `err()`.)
 */
export class MergeGateBlockedError extends Error {
  status = 409;
  code: string;
  hint = 'Rebase onto / fully merge into the base branch, or pass force=true to override the merge gate.';
  constructor(result: MergeGateResult) {
    super(result.message || 'Merge gate blocked this move.');
    this.code = result.code || 'merge_gate_blocked';
    this.name = 'MergeGateBlockedError';
  }
}
