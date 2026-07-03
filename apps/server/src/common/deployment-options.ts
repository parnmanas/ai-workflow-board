import type { Repository } from 'typeorm';
import type { Deployment } from '../entities/Deployment';

/**
 * Deployment-awareness helpers (ticket 8ce72b18).
 *
 * "Merged ≠ deployed" is the recurring false-negative in the automation loop:
 * a fix ticket hits Done and something re-runs (QA rerun-on-fix) or is verified
 * against the RUNNING environment — which auto-deploys AFTER main merges, so the
 * old code is exercised. These pure helpers let the server GATE deployment-
 * dependent automation on the *fact* of a deployment (the live commit for an
 * environment) instead of a best-effort time delay.
 *
 * Kept dependency-free (no NestJS DI, only the entity + a passed Repository) so
 * both DeploymentService and the QA services can share the exact same ancestor
 * logic without a module import cycle — mirrors common/build-artifact-options.ts.
 */

/** Sources a deployment record can come from. Free-text kept to a known set. */
export type DeploymentSource = 'self_report' | 'webhook' | 'mcp' | 'poll' | 'manual';

export const DEPLOYMENT_SOURCES: DeploymentSource[] = ['self_report', 'webhook', 'mcp', 'poll', 'manual'];

/** The environment name the AWB server self-reports its own build under. */
export const SELF_DEPLOY_ENV_DEFAULT = 'awb-server';

/** Normalize a commit sha for comparison: trim + lowercase (hex is case-insensitive). */
export function normalizeSha(sha: string | null | undefined): string {
  return (sha || '').trim().toLowerCase();
}

/**
 * Two shas "match" when they are equal, or one is a git-style abbreviated prefix
 * of the other (both ≥ 7 hex chars — git's default short-sha length). This lets a
 * `fix-commit:<short>` label match a full deployed sha and vice-versa without the
 * server needing a real clone to expand it.
 */
export function shaMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizeSha(a);
  const y = normalizeSha(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const min = Math.min(x.length, y.length);
  if (min < 7) return false;
  return x.startsWith(y) || y.startsWith(x);
}

/** Minimal shape the ancestor check needs — the entity satisfies it. */
export interface DeploymentCommitInfo {
  deployed_commit_sha: string;
  ancestor_shas?: string[] | null;
}

/**
 * Does this deployment INCLUDE `sha` — i.e. is `sha` the deployed commit itself,
 * or a known ancestor of it? This is the "deployed_commit contains the fix" gate
 * (DoD item 3). Ancestry is data-driven: the reporter supplies `ancestor_shas`
 * (the server self-report computes it from its own `git rev-list`; an external
 * webhook/MCP reporter passes the recent history) so the server never needs a
 * clone of the SUT to answer it. Empty `sha` → false (can't prove inclusion).
 */
export function deploymentIncludesCommit(dep: DeploymentCommitInfo | null | undefined, sha: string | null | undefined): boolean {
  const target = normalizeSha(sha);
  if (!dep || !target) return false;
  if (shaMatches(dep.deployed_commit_sha, target)) return true;
  const anc = Array.isArray(dep.ancestor_shas) ? dep.ancestor_shas : [];
  return anc.some((a) => shaMatches(a, target));
}

/**
 * The current live deployment for `environment` as seen by a given workspace.
 * A workspace-scoped row shadows a global (null-workspace) one, but we simply
 * pick the freshest by deployed_at across {workspace-scoped, global} — a global
 * self-report that is newer than a stale workspace override should still win
 * (the environment genuinely moved forward). `workspaceId` null → global only.
 */
export async function findLatestDeployment(
  repo: Repository<Deployment>,
  workspaceId: string | null | undefined,
  environment: string,
): Promise<Deployment | null> {
  const env = (environment || '').trim();
  if (!env) return null;
  const qb = repo.createQueryBuilder('d').where('d.environment = :env', { env });
  if (workspaceId) {
    qb.andWhere('(d.workspace_id = :ws OR d.workspace_id IS NULL)', { ws: workspaceId });
  } else {
    qb.andWhere('d.workspace_id IS NULL');
  }
  qb.orderBy('d.deployed_at', 'DESC').addOrderBy('d.created_at', 'DESC');
  return qb.getOne();
}

/**
 * Resolve the AWB server's own build commit for the boot-time self-report.
 * Checks the common CI/PaaS commit env vars in priority order; '' when unknown
 * (self-report then no-ops — a deploy that wants server-as-SUT gating must bake
 * one of these into the image / process env). Kept env-only (no git shell-out)
 * so it is deterministic and safe in the production container.
 */
export function resolveBuildCommit(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [
    env.AWB_BUILD_COMMIT,
    env.GIT_COMMIT,
    env.SOURCE_COMMIT,        // Docker Hub / generic
    env.RENDER_GIT_COMMIT,    // Render
    env.RAILWAY_GIT_COMMIT_SHA,
    env.VERCEL_GIT_COMMIT_SHA,
    env.HEROKU_SLUG_COMMIT,
    env.COMMIT_SHA,
  ];
  for (const c of candidates) {
    const v = (c || '').trim();
    if (v) return v;
  }
  return '';
}
