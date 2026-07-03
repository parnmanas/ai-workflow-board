import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { Deployment } from '../../entities/Deployment';
import {
  DeploymentSource,
  DEPLOYMENT_SOURCES,
  SELF_DEPLOY_ENV_DEFAULT,
  findLatestDeployment,
  normalizeSha,
  resolveBuildCommit,
} from '../../common/deployment-options';
import { activityEvents } from '../../services/activity.service';
import { LogService } from '../../services/log.service';

function makeError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

export interface ReportDeploymentInput {
  /** null / omitted = a GLOBAL (shared) environment. */
  workspaceId?: string | null;
  environment: string;
  deployedCommitSha: string;
  baseUrl?: string;
  repoResourceId?: string;
  ancestorShas?: string[];
  source?: DeploymentSource;
  reportedBy?: string;
  /** Defaults to now. Accepts an ISO string or Date (webhook may carry the real deploy instant). */
  deployedAt?: Date | string | null;
}

/**
 * The event QaRerunOnFixService (and any future deployment-gated automation)
 * listens for. Emitted on the shared `activityEvents` bus under a DEDICATED name
 * (not the generic 'activity' channel) so it stays purely in-process — no
 * ActivityLog row, no SSE registry entry, no agent-manager contract change.
 */
export const DEPLOYMENT_REPORTED_EVENT = 'deployment_reported';

export interface DeploymentReportedSignal {
  deployment_id: string;
  workspace_id: string | null;
  environment: string;
  deployed_commit_sha: string;
  deployed_at: Date | null;
}

/**
 * DeploymentService — the authority for "what commit is live where" (ticket
 * 8ce72b18). Stateless over the DataSource (mirrors BuildArtifactService), so the
 * standalone MCP context can `new DeploymentService(dataSource, log)` without DI.
 *
 * `report()` UPSERTs one row per (workspace_id, environment) — the current live
 * commit, not a history log — then emits DEPLOYMENT_REPORTED_EVENT so a pending
 * deployment-gated rerun re-evaluates and fires the moment the deploy that
 * includes the fix lands.
 */
@Injectable()
export class DeploymentService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logService: LogService,
  ) {}

  private get repo(): Repository<Deployment> {
    return this.dataSource.getRepository(Deployment);
  }

  /** Record (upsert) the live commit for an environment and fan out the signal. */
  async report(input: ReportDeploymentInput): Promise<Deployment> {
    const environment = (input.environment || '').trim();
    if (!environment) throw makeError(400, 'environment is required');
    const deployedCommitSha = (input.deployedCommitSha || '').trim();
    if (!deployedCommitSha) throw makeError(400, 'deployed_commit_sha is required');

    const workspaceId = input.workspaceId ? String(input.workspaceId).trim() || null : null;
    const source: DeploymentSource = DEPLOYMENT_SOURCES.includes(input.source as DeploymentSource)
      ? (input.source as DeploymentSource)
      : 'manual';
    const deployedAt = this._coerceDate(input.deployedAt) ?? new Date();
    // Cap ancestry so a huge history payload can't bloat the row.
    const ancestorShas = Array.isArray(input.ancestorShas)
      ? input.ancestorShas.map((s) => normalizeSha(s)).filter(Boolean).slice(0, 500)
      : undefined;

    // UPSERT by identity (workspace_id, environment). Null workspace uses IsNull()
    // so the global row is matched (a plain `{ workspace_id: null }` where works in
    // TypeORM but IsNull() is explicit + index-friendly).
    const existing = await this.repo.findOne({
      where: { environment, workspace_id: workspaceId === null ? IsNull() : workspaceId },
    });

    const patch: Partial<Deployment> = {
      workspace_id: workspaceId,
      environment,
      base_url: (input.baseUrl ?? existing?.base_url ?? '').trim(),
      repo_resource_id: (input.repoResourceId ?? existing?.repo_resource_id ?? '').trim(),
      deployed_commit_sha: deployedCommitSha,
      ancestor_shas: ancestorShas ?? existing?.ancestor_shas ?? null,
      source,
      reported_by: (input.reportedBy ?? existing?.reported_by ?? '').trim(),
      deployed_at: deployedAt,
    };

    let row: Deployment;
    if (existing) {
      Object.assign(existing, patch);
      row = await this.repo.save(existing);
    } else {
      row = await this.repo.save(this.repo.create(patch));
    }

    this.logService.info(
      'Deploy',
      `deployment recorded — env=${environment}${workspaceId ? ` ws=${workspaceId}` : ' (global)'} commit=${deployedCommitSha.slice(0, 12)} source=${source}`,
      { id: row.id },
    );

    // Fan-out (in-process only). Fire-and-forget: a listener error must not fail
    // the report. QaRerunOnFixService picks this up to re-evaluate waiting reruns.
    const signal: DeploymentReportedSignal = {
      deployment_id: row.id,
      workspace_id: row.workspace_id,
      environment: row.environment,
      deployed_commit_sha: row.deployed_commit_sha,
      deployed_at: row.deployed_at,
    };
    try {
      activityEvents.emit(DEPLOYMENT_REPORTED_EVENT, signal);
    } catch (e) {
      this.logService.warn('Deploy', `deployment_reported emit failed: ${String(e)}`);
    }

    return row;
  }

  /** The current live deployment for an environment as a given workspace sees it. */
  async getLatest(workspaceId: string | null | undefined, environment: string): Promise<Deployment | null> {
    return findLatestDeployment(this.repo, workspaceId ?? null, environment);
  }

  /**
   * List the current live deployment per environment visible to a workspace
   * (its own environments + all global ones). One row per environment name (the
   * freshest). Powers the board/QA "live commit" badge (DoD item 5).
   */
  async listForWorkspace(workspaceId: string | null | undefined): Promise<Deployment[]> {
    const qb = this.repo.createQueryBuilder('d');
    if (workspaceId) {
      qb.where('(d.workspace_id = :ws OR d.workspace_id IS NULL)', { ws: workspaceId });
    } else {
      qb.where('d.workspace_id IS NULL');
    }
    qb.orderBy('d.deployed_at', 'DESC').addOrderBy('d.created_at', 'DESC');
    const rows = await qb.getMany();
    // Collapse to the freshest row per environment name (workspace row shadows a
    // global only when it is genuinely newer — same rule as findLatestDeployment).
    const byEnv = new Map<string, Deployment>();
    for (const r of rows) {
      if (!byEnv.has(r.environment)) byEnv.set(r.environment, r);
    }
    return [...byEnv.values()];
  }

  /**
   * Boot-time self-report: record the AWB server's own build commit as a GLOBAL
   * deployment (DoD item 2, "server self-report"). No-ops unless a commit is
   * resolvable from the environment (resolveBuildCommit) — a deploy that wants
   * server-as-SUT gating bakes AWB_BUILD_COMMIT (or a known CI var) into the
   * process env. Env name defaults to `awb-server`, overridable via
   * AWB_SELF_DEPLOY_ENVIRONMENT. Best-effort: never throws to the boot path.
   */
  async recordSelfDeployment(env: NodeJS.ProcessEnv = process.env): Promise<Deployment | null> {
    const commit = resolveBuildCommit(env);
    if (!commit) {
      this.logService.info('Deploy', 'self-deployment skipped — no build commit in env (set AWB_BUILD_COMMIT to enable server-as-SUT gating)');
      return null;
    }
    const environment = (env.AWB_SELF_DEPLOY_ENVIRONMENT || SELF_DEPLOY_ENV_DEFAULT).trim() || SELF_DEPLOY_ENV_DEFAULT;
    // Optional ancestry via env (newline/space/comma separated) so the ancestor
    // gate works for the server's own history (the image build can bake
    // `git rev-list --max-count=200 HEAD` into AWB_BUILD_ANCESTORS).
    const ancestorShas = this._parseAncestorsEnv(env.AWB_BUILD_ANCESTORS);
    try {
      return await this.report({
        workspaceId: null,
        environment,
        deployedCommitSha: commit,
        baseUrl: (env.AWB_SELF_BASE_URL || '').trim(),
        ancestorShas,
        source: 'self_report',
        reportedBy: 'awb-server',
      });
    } catch (e: any) {
      this.logService.warn('Deploy', `self-deployment record failed: ${e?.message || e}`);
      return null;
    }
  }

  private _parseAncestorsEnv(raw: string | undefined): string[] | undefined {
    if (!raw) return undefined;
    const list = raw.split(/[\s,]+/).map((s) => normalizeSha(s)).filter(Boolean);
    return list.length ? list : undefined;
  }

  private _coerceDate(v: Date | string | null | undefined): Date | null {
    if (!v) return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
}
