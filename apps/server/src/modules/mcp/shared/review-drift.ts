/**
 * Review-drift classification (ticket 59efbde9).
 *
 * `review_workflow`'s old base-freshness gate bounced Review → In Progress on
 * ANY origin/main advance since the branch forked, regardless of whether the
 * advance touched anything this ticket's branch cares about. Under concurrent
 * merges from OTHER tickets, main can advance every few minutes — ec498050's
 * retrospective found the same non-conflicting drift bouncing one ticket 5
 * times in a row (rebase → full suite → re-review, repeated, with the
 * ticket's own diff staying approved the whole time).
 *
 * This module classifies a Review episode's drift by PATH OVERLAP instead of
 * raw commit count — `merge-gate.ts`'s `countBehindAhead` already gates on
 * commit count (behind>0), a coarser, separate layer — and pairs the
 * classification with a per-episode reverification budget so the SAME
 * episode can bounce at most once (`MAX_DRIFT_REVERIFICATIONS`) before this
 * classifier starts recommending Merging's own rebase-before-land step as the
 * episode's final re-verification point instead of another Review round-trip.
 *
 * Same conventions as `merge-gate.ts`: a pure classifier (`classifyDrift`,
 * fully unit-testable, no DB/git), an injectable git prober swappable for
 * tests (`__setReviewDriftProbeForTests`, same shape as
 * `__setMergeGateProbeForTests`), and an availability-first orchestrator
 * (`checkReviewDrift`) that degrades to `proceed_no_action` on ANY
 * unresolvable repo/branch/git condition — this tool must never itself
 * manufacture a block a human has to clear.
 *
 * Real conflict prediction is explicitly out of scope: path overlap is a
 * heuristic upper bound, not a merge simulation. Whether an overlap actually
 * conflicts is left to Merging's existing "integrate, don't bounce" rebase
 * step, which already handles it.
 */

import type { DataSource, EntityManager } from 'typeorm';
import { Credential } from '../../../entities/Credential';
import { DriftClassification, ReviewDriftState } from '../../../entities/ReviewDriftState';
import { Resource } from '../../../entities/Resource';
import { Ticket } from '../../../entities/Ticket';
import { resolveGitCredential } from './git-branches';
import {
  diffChangedPaths,
  ensureRepoCache,
  GitCredential,
  listCommits,
  listRefs,
} from './git-repo-cache';

type RepoScope = DataSource | EntityManager;

// ── budget (env-overridable, same numEnv convention as git-repo-cache.ts) ──
function numEnv(key: string, def: number): number {
  const v = parseInt(process.env[key] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

/** Max times a single Review episode may bounce before this classifier stops
 *  recommending a rebase round-trip and defers to Merging's own rebase
 *  instead. 1 = "at most one round-trip", the literal translation of this
 *  ticket's requirement. Episode-wide, not per-distinct-drift-reason: once
 *  spent, every later overlapping call in the same episode reports
 *  `overlapping_drift_budget_exhausted`, never a second `overlapping_drift`. */
export const MAX_DRIFT_REVERIFICATIONS = numEnv('AWB_MAX_DRIFT_REVERIFICATIONS', 1);

// ── path-overlap rules (Q1) ─────────────────────────────────────────────────
// Repo-wide files: a main-side change here is treated as overlapping
// regardless of what the ticket's own branch touched — a lockfile/tooling
// config change can affect every branch's build even with zero literal path
// intersection. Deliberately cast wide (Q1: broad is cheap here — the budget
// above already caps the cost at one bounce per episode; missing a real
// overlap lets a regression through instead).
const REPO_GLOBAL_FILES = new Set<string>(['package.json', 'package-lock.json', 'turbo.json']);
function isRepoGlobalPath(p: string): boolean {
  if (REPO_GLOBAL_FILES.has(p)) return true;
  if (/^tsconfig(\..+)?\.json$/.test(p)) return true;
  if (p.startsWith('.github/workflows/')) return true;
  return false;
}

function parentDir(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx === -1 ? '' : p.slice(0, idx);
}

/** Rule ① exact path intersection, ② immediate parent directory
 *  intersection, or ③ main touched a repo-global file (Q1). */
function pathsOverlap(branchPaths: string[], mainDriftPaths: string[]): boolean {
  if (mainDriftPaths.some(isRepoGlobalPath)) return true;
  if (branchPaths.length === 0) return false;

  const branchExact = new Set(branchPaths);
  const branchDirs = new Set(branchPaths.map(parentDir));
  for (const p of mainDriftPaths) {
    if (branchExact.has(p)) return true;
    if (branchDirs.has(parentDir(p))) return true;
  }
  return false;
}

/**
 * Pure classifier — Q1's three overlap rules + Q2's reverification budget.
 * No DB / git, so the full truth table is unit-testable without a network.
 *
 *   - no main drift at all                        → 'fresh'
 *   - drift, but no path overlap with the branch   → 'non_overlapping_drift'
 *   - drift, overlapping, budget not yet spent     → 'overlapping_drift'
 *   - drift, overlapping, budget already spent     → 'overlapping_drift_budget_exhausted'
 */
export function classifyDrift(
  branchPaths: string[],
  mainDriftPaths: string[],
  reverificationCount: number,
): DriftClassification {
  if (!mainDriftPaths || mainDriftPaths.length === 0) return 'fresh';
  if (!pathsOverlap(branchPaths || [], mainDriftPaths)) return 'non_overlapping_drift';
  return reverificationCount < MAX_DRIFT_REVERIFICATIONS
    ? 'overlapping_drift'
    : 'overlapping_drift_budget_exhausted';
}

export type DriftRecommendation = 'proceed' | 'rebase_required' | 'proceed_no_action';

/** classification → recommendation. Only a budget-remaining overlap ever
 *  recommends a bounce; a budget-exhausted overlap still proceeds (so the
 *  episode converges instead of round-tripping forever) but is distinguished
 *  as `proceed_no_action` rather than a clean `proceed`, since it is telling
 *  the reviewer "I would have asked for a rebase, but this episode already
 *  spent its one bounce" rather than "nothing is going on". */
export function recommendationFor(classification: DriftClassification): DriftRecommendation {
  if (classification === 'overlapping_drift') return 'rebase_required';
  if (classification === 'overlapping_drift_budget_exhausted') return 'proceed_no_action';
  return 'proceed';
}

// ── feature-branch naming convention ────────────────────────────────────────
// Duplicated from merge-gate.ts (not imported) to keep the two modules
// independent — same rationale as git-repo-cache.ts's duplicated
// `applyCredential` (see that file's docstring) — and to avoid a
// review-drift.ts <-> merge-gate.ts import cycle: merge-gate.ts imports THIS
// module's `DriftClassification` re-export for its Q3 overlap-aware
// integration (see decideMergeGate in merge-gate.ts).
function featureBranchPrefix(ticketId: string): string {
  return `ticket/${(ticketId || '').slice(0, 8)}`;
}
function resolveFeatureBranch(ticketId: string, branches: string[]): string | null {
  const prefix = featureBranchPrefix(ticketId);
  const matches = branches.filter((b) => b === prefix || b.startsWith(`${prefix}-`));
  if (matches.length === 0) return null;
  matches.sort((a, b) => a.localeCompare(b));
  return matches[0];
}

// ── git prober (injectable for tests, same shape as merge-gate.ts) ─────────
export interface ReviewDriftProbeInput {
  resource: Resource;
  credential: GitCredential;
  baseBranch: string;
  ticketId: string;
  /** Base SHA captured at this episode's entry, or null when no
   *  ReviewDriftState row exists yet (nothing to diff main's movement
   *  against — the probe should report zero drift). */
  baseShaAtEntry: string | null;
}

export interface ReviewDriftProbeResult {
  baseTipSha: string;
  featureBranch: string;
  featureTipSha: string;
  /** The feature branch's own changed paths vs base (3-dot, merge-base
   *  relative) — what THIS ticket touched. */
  branchPaths: string[];
  /** Paths main touched between `baseShaAtEntry` and the current base tip
   *  (2-dot, direct range). Empty when `baseShaAtEntry` is null or main
   *  hasn't moved since. */
  mainDriftPaths: string[];
}

export type ReviewDriftProbe = (input: ReviewDriftProbeInput) => Promise<ReviewDriftProbeResult | null>;

/**
 * Test-only override for the prober `checkReviewDrift` uses. Production
 * leaves it null → the real cache-clone prober runs. A qa-flow spec (which
 * boots the app in-process from the same compiled module) sets a
 * deterministic stub so a sequence of drift states can be driven over the
 * real MCP `check_review_drift` tool without a live git remote.
 */
let testProbeOverride: ReviewDriftProbe | null = null;
export function __setReviewDriftProbeForTests(probe: ReviewDriftProbe | null): void {
  testProbeOverride = probe;
}

export const defaultReviewDriftProbe: ReviewDriftProbe = async ({ resource, credential, baseBranch, ticketId, baseShaAtEntry }) => {
  try {
    const repoPath = await ensureRepoCache({
      resourceId: resource.id,
      url: resource.url,
      credential,
      // Always fetch fresh — a drift check right after a concurrent merge
      // must see the current remote tips, not a ≤60s-stale cache.
      forceFetch: true,
    });
    const refs = await listRefs(repoPath);
    const feature = resolveFeatureBranch(ticketId, refs.branches);
    if (!feature) return null;
    if (!refs.branches.includes(baseBranch)) return null;

    const [baseCommits, featureCommits] = await Promise.all([
      listCommits({ repoPath, ref: baseBranch, limit: 1 }),
      listCommits({ repoPath, ref: feature, limit: 1 }),
    ]);
    const baseTipSha = baseCommits[0]?.sha;
    const featureTipSha = featureCommits[0]?.sha;
    if (!baseTipSha || !featureTipSha) return null;

    const branchPaths = await diffChangedPaths(repoPath, baseBranch, feature, { threeDot: true });
    const mainDriftPaths = baseShaAtEntry && baseShaAtEntry !== baseTipSha
      ? await diffChangedPaths(repoPath, baseShaAtEntry, baseTipSha, { threeDot: false })
      : [];

    return { baseTipSha, featureBranch: feature, featureTipSha, branchPaths, mainDriftPaths };
  } catch {
    // SshUnsupportedError / GitReadError / anything else → unverifiable.
    return null;
  }
};

// ── orchestrator ─────────────────────────────────────────────────────────────
export interface CheckReviewDriftResult {
  drifted: boolean;
  classification: DriftClassification | null;
  recommendation: DriftRecommendation;
  overlapping_paths: string[];
  reverification_count: number;
  max_reverifications: number;
  /** Diagnostic outcome for logging / tests. */
  outcome: 'unresolvable' | 'entry' | 'checked';
}

export interface CheckReviewDriftOptions {
  /** Injectable git prober (defaults to the real cache-clone prober). */
  probe?: ReviewDriftProbe;
  logger?: { warn?: (cat: string, msg: string, meta?: any) => void };
}

const UNRESOLVABLE: CheckReviewDriftResult = {
  drifted: false,
  classification: null,
  recommendation: 'proceed_no_action',
  overlapping_paths: [],
  reverification_count: 0,
  max_reverifications: MAX_DRIFT_REVERIFICATIONS,
  outcome: 'unresolvable',
};

/**
 * Lazy-upsert `ReviewDriftState` for this ticket and classify any main drift
 * since the episode's entry snapshot. Never throws — every unresolvable step
 * (no repo configured, git unavailable, feature/base branch not found)
 * degrades to `proceed_no_action`, same availability-first philosophy as
 * `evaluateMergeGate`. This tool must never itself be the reason a ticket
 * gets stuck.
 *
 * The entry snapshot (`base_sha_at_entry` / `branch_tip_sha_at_entry` /
 * `changed_paths_at_entry`) is captured ONCE, on the first call for a given
 * `ReviewDriftState` row, and never touched again — `reverification_count`
 * is the only field a Review↔In Progress bounce is allowed to leave
 * standing, and the row itself (entry snapshot included) is deleted wholesale
 * only at episode end (see `ticket-move.ts`). `branchPaths` is still
 * re-probed fresh on every call (a live comparison, not the stored snapshot)
 * so a branch that gains new commits mid-review is still checked accurately.
 */
export async function checkReviewDrift(
  scope: RepoScope,
  ticket: Ticket,
  options: CheckReviewDriftOptions = {},
): Promise<CheckReviewDriftResult> {
  if (!ticket.base_repo_resource_id || !ticket.workspace_id) return UNRESOLVABLE;
  const resource = await scope.getRepository(Resource).findOne({ where: { id: ticket.base_repo_resource_id } });
  if (resource && resource.workspace_id !== null && resource.workspace_id !== ticket.workspace_id) return UNRESOLVABLE;
  if (!resource?.url) return UNRESOLVABLE;
  const baseBranch = ticket.base_branch || resource.default_branch || '';
  if (!baseBranch) return UNRESOLVABLE;

  const stateRepo = scope.getRepository(ReviewDriftState);
  const existing = await stateRepo.findOne({ where: { ticket_id: ticket.id } });

  let credential: GitCredential = null;
  try {
    credential = await resolveGitCredential(scope.getRepository(Credential), resource.credential_id, ticket.workspace_id, resource.board_id);
  } catch {
    credential = null;
  }

  const probe = options.probe ?? testProbeOverride ?? defaultReviewDriftProbe;
  let probed: ReviewDriftProbeResult | null;
  try {
    probed = await probe({
      resource, credential, baseBranch, ticketId: ticket.id,
      baseShaAtEntry: existing?.base_sha_at_entry || null,
    });
  } catch (e) {
    options.logger?.warn?.('ReviewDrift', 'probe threw (degrading to proceed_no_action)', {
      err: String(e), ticket_id: ticket.id,
    });
    probed = null;
  }
  if (!probed) return UNRESOLVABLE;

  const isEntry = !existing;
  const reverificationCount = existing?.reverification_count ?? 0;
  const classification = classifyDrift(probed.branchPaths, probed.mainDriftPaths, reverificationCount);
  const recommendation = recommendationFor(classification);
  const bumpCount = classification === 'overlapping_drift';
  const nextCount = bumpCount ? reverificationCount + 1 : reverificationCount;

  if (isEntry) {
    await stateRepo.save(stateRepo.create({
      ticket_id: ticket.id,
      workspace_id: ticket.workspace_id,
      board_id: resource.board_id || '',
      base_branch: baseBranch,
      base_sha_at_entry: probed.baseTipSha,
      branch_tip_sha_at_entry: probed.featureTipSha,
      changed_paths_at_entry: JSON.stringify(probed.branchPaths),
      last_checked_base_sha: probed.baseTipSha,
      last_classification: classification,
      reverification_count: nextCount,
    }));
  } else {
    await stateRepo.update(ticket.id, {
      last_checked_base_sha: probed.baseTipSha,
      last_classification: classification,
      // reverification_count intentionally omitted from the update when it
      // doesn't change — the entry snapshot's counter must survive every
      // call this row lives through, not just bounce-triggering ones.
      ...(bumpCount ? { reverification_count: nextCount } : {}),
    });
  }

  return {
    drifted: classification !== 'fresh',
    classification,
    recommendation,
    overlapping_paths: classification === 'overlapping_drift' || classification === 'overlapping_drift_budget_exhausted'
      ? probed.mainDriftPaths
      : [],
    reverification_count: nextCount,
    max_reverifications: MAX_DRIFT_REVERIFICATIONS,
    outcome: isEntry ? 'entry' : 'checked',
  };
}

export type { DriftClassification };
