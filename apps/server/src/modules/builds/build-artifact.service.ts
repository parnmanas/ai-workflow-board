import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { BuildArtifact, BuildArtifactStatus } from '../../entities/BuildArtifact';
import { BuildRepoRef, buildRepoKey } from '../../common/build-artifact-options';
import { LogService } from '../../services/log.service';

function makeError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

export interface RegisterBuildArtifactInput {
  workspaceId: string;
  boardId?: string | null;
  repo: BuildRepoRef;
  target: string;
  commitSha: string;
  status?: BuildArtifactStatus;
  artifactPath?: string;
  artifactHash?: string;
  artifactResourceId?: string;
  host?: string;
  builderAgentId?: string;
  logSummary?: string;
  runId?: string;
}

export interface ReportBuildFailureInput {
  workspaceId: string;
  boardId?: string | null;
  repo: BuildRepoRef;
  target: string;
  commitSha?: string;
  host?: string;
  builderAgentId?: string;
  logSummary: string;
  runId?: string;
}

export interface GetLatestArtifactInput {
  workspaceId: string;
  repo: BuildRepoRef;
  target: string;
  /** When set, freshness is decided against this exact commit. */
  commitSha?: string;
  /** When set, reuse is scoped to this machine (plus legacy unscoped rows). */
  host?: string;
}

export interface GetLatestArtifactResult {
  /** Newest `ok` artifact for repo+target (any commit) — provenance / fallback. */
  artifact: BuildArtifact | null;
  /** Newest `ok` artifact for the EXACT commit_sha (null when none / no commit given). */
  commit_match: BuildArtifact | null;
  /** true ⇔ commit_match exists — the run can skip the build. */
  is_fresh: boolean;
}

/**
 * BuildArtifactService — the registry authority for the Build & Artifact model
 * (ticket 80d52250). Stateless over the DataSource (mirrors BenchmarkService),
 * so the standalone MCP context can `new BuildArtifactService(dataSource, log)`
 * without NestJS DI.
 *
 * The cold/warm decision the whole ticket hinges on lives in `getLatest`:
 * `is_fresh` is true only when an `ok` artifact exists for the EXACT commit the
 * run is about to test — never merely because SOME prior build exists. That is
 * the structural fix for the stale-warm-exe race (`decideRunFreshness` returned
 * WARM whenever `last_built_commit` was non-empty, regardless of whether it
 * matched the HEAD in play).
 */
@Injectable()
export class BuildArtifactService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logService: LogService,
  ) {}

  private get repo(): Repository<BuildArtifact> {
    return this.dataSource.getRepository(BuildArtifact);
  }

  /** Resolve + validate the repo share key, or throw a 400. */
  private resolveKey(repo: BuildRepoRef): string {
    const key = buildRepoKey(repo);
    if (!key) throw makeError(400, 'repo must carry a resource_id or url so the artifact has a stable key');
    return key;
  }

  /**
   * Upsert an artifact record keyed by (workspace, repo_key, target, commit_sha,
   * host). A rebuild of the same commit (e.g. failed → ok) updates the existing
   * row rather than piling duplicates.
   */
  async register(input: RegisterBuildArtifactInput): Promise<BuildArtifact> {
    const workspaceId = (input.workspaceId || '').trim();
    if (!workspaceId) throw makeError(400, 'workspace_id is required');
    const target = (input.target || '').trim();
    if (!target) throw makeError(400, 'target is required');
    const commitSha = (input.commitSha || '').trim();
    if (!commitSha) throw makeError(400, 'commit_sha is required');
    const repoKey = this.resolveKey(input.repo);

    const status: BuildArtifactStatus = input.status ?? 'ok';
    const host = (input.host || '').trim();

    const row = await this.upsert(workspaceId, repoKey, target, commitSha, host, {
      board_id: input.boardId ?? null,
      repo_resource_id: (input.repo.resource_id || '').trim(),
      repo_url: (input.repo.url || '').trim(),
      status,
      artifact_path: input.artifactPath ?? '',
      artifact_hash: input.artifactHash ?? '',
      artifact_resource_id: input.artifactResourceId ?? '',
      builder_agent_id: input.builderAgentId ?? '',
      log_summary: input.logSummary ?? '',
      run_id: input.runId ?? '',
      // 'building' is still in flight → no finish timestamp; ok/failed are terminal.
      built_at: status === 'building' ? null : new Date(),
    });
    this.logService.info(
      'Build',
      `artifact ${status} — repo_key=${repoKey} target=${target} commit=${commitSha}${host ? ` host=${host}` : ''}`,
      { id: row.id, run_id: row.run_id },
    );
    return row;
  }

  /**
   * Record a build FAILURE as a first-class registry row (status='failed' + the
   * log tail). Does NOT touch any run — the caller (report_build_failure tool)
   * finalizes the QaRun as `build_failed` separately, so this stays run-agnostic
   * and reusable by security / dev builds.
   */
  async reportFailure(input: ReportBuildFailureInput): Promise<BuildArtifact> {
    const workspaceId = (input.workspaceId || '').trim();
    if (!workspaceId) throw makeError(400, 'workspace_id is required');
    const target = (input.target || '').trim();
    if (!target) throw makeError(400, 'target is required');
    const logSummary = (input.logSummary || '').trim();
    if (!logSummary) throw makeError(400, 'log_summary is required for a build failure');
    const repoKey = this.resolveKey(input.repo);
    // A build can die before HEAD is resolvable; '' is allowed (recorded as an
    // unpinned failure) rather than rejecting the report.
    const commitSha = (input.commitSha || '').trim();
    const host = (input.host || '').trim();

    const row = await this.upsert(workspaceId, repoKey, target, commitSha, host, {
      board_id: input.boardId ?? null,
      repo_resource_id: (input.repo.resource_id || '').trim(),
      repo_url: (input.repo.url || '').trim(),
      status: 'failed',
      builder_agent_id: input.builderAgentId ?? '',
      log_summary: logSummary,
      run_id: input.runId ?? '',
      built_at: new Date(),
    });
    this.logService.warn(
      'Build',
      `build FAILED — repo_key=${repoKey} target=${target} commit=${commitSha || '(unknown)'}`,
      { id: row.id, run_id: row.run_id },
    );
    return row;
  }

  /**
   * The freshness read. Returns the newest usable (`ok`) artifact for repo+target
   * and, when a commit is given, whether that EXACT commit is already built
   * (`is_fresh`). Host-scoped when a host is supplied (a machine can only reuse
   * its own local artifacts) — legacy unscoped ('') rows still match as a
   * fallback.
   */
  async getLatest(input: GetLatestArtifactInput): Promise<GetLatestArtifactResult> {
    const workspaceId = (input.workspaceId || '').trim();
    if (!workspaceId) throw makeError(400, 'workspace_id is required');
    const target = (input.target || '').trim();
    if (!target) throw makeError(400, 'target is required');
    const repoKey = this.resolveKey(input.repo);
    const host = (input.host || '').trim();

    const base: Record<string, any> = {
      workspace_id: workspaceId,
      repo_key: repoKey,
      target,
      status: 'ok',
    };
    // host present → match this machine OR legacy unscoped rows; absent → any host.
    if (host) base.host = In([host, '']);

    const order = { built_at: 'DESC', created_at: 'DESC' } as const;
    const artifact = await this.repo.findOne({ where: base, order });

    let commit_match: BuildArtifact | null = null;
    const commitSha = (input.commitSha || '').trim();
    if (commitSha) {
      commit_match = await this.repo.findOne({ where: { ...base, commit_sha: commitSha }, order });
    }

    return { artifact, commit_match, is_fresh: !!commit_match };
  }

  /** Find the existing row for the identity tuple and patch it, else insert. */
  private async upsert(
    workspaceId: string,
    repoKey: string,
    target: string,
    commitSha: string,
    host: string,
    patch: Partial<BuildArtifact>,
  ): Promise<BuildArtifact> {
    const existing = await this.repo.findOne({
      where: { workspace_id: workspaceId, repo_key: repoKey, target, commit_sha: commitSha, host },
    });
    if (existing) {
      Object.assign(existing, patch);
      return this.repo.save(existing);
    }
    return this.repo.save(
      this.repo.create({
        workspace_id: workspaceId,
        repo_key: repoKey,
        target,
        commit_sha: commitSha,
        host,
        ...patch,
      }),
    );
  }
}
