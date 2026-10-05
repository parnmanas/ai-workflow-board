import { Injectable } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { In, Repository, DataSource } from 'typeorm';
import { QaScenario, QaScenarioStep, QaOnFailureTicketConfig } from '../../entities/QaScenario';
import { QaRun, QaRunStatus } from '../../entities/QaRun';
import { ApiKey } from '../../entities/ApiKey';
import { RuntimeHost } from '../../entities/RuntimeHost';
import { findOrFail } from '../../common/find-or-fail';
import { agentIsVisibleInWorkspace } from '../../common/agent-account-scope';
import { normalizeRuntimeSpec, runtimeIdentityKey } from '../../common/runtime-spec';
import { resolveCallerIdentityRow } from '../mcp/shared/authz';
import {
  normalizeWorkspaceFolder,
  normalizeCheckoutMode,
  normalizeBuildMode,
  normalizeRepoRef,
} from '../../common/workspace-folder-options';
import { normalizeBuildTarget } from '../../common/build-artifact-options';
import { normalizeTags as normalizeTicketTags } from '../tickets/ticket.service';
import { QaRunService } from './qa-run.service';

function makeError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

/** Normalize the loose `steps` input into a clean ordered array. */
function normalizeSteps(steps: any): QaScenarioStep[] {
  if (!Array.isArray(steps)) return [];
  return steps.map((s, i) => ({
    idx: typeof s?.idx === 'number' ? s.idx : i,
    action: String(s?.action ?? ''),
    expect: s?.expect != null ? String(s.expect) : undefined,
    mcp_tool: s?.mcp_tool != null ? String(s.mcp_tool) : undefined,
    params: s?.params && typeof s.params === 'object' ? s.params : undefined,
  }));
}

function normalizeTags(tags: any): string[] {
  if (!Array.isArray(tags)) return [];
  return tags.map((t) => String(t)).filter(Boolean);
}

/**
 * Normalize the loose `on_failure_ticket` input into a clean config (or null).
 * `null` / `{ enabled:false }` both disable the side-effect; every other field
 * is optional and defaulted at dispatch time in QaFailureTicketService.
 * A `labels` input (the pre-board-removal name) is accepted as `tags`; the
 * removed board/column/assignee_id keys are dropped.
 */
function normalizeOnFailureTicket(input: any): QaOnFailureTicketConfig | null {
  if (input == null) return null;
  if (typeof input !== 'object') return null;
  const priority = ['low', 'medium', 'high', 'critical'].includes(input.priority) ? input.priority : undefined;
  const dedupe = input.dedupe === 'per_open_ticket' ? 'per_open_ticket' : (input.dedupe === 'per_run' ? 'per_run' : undefined);
  const status = input.status === 'backlog' || input.status === 'todo' ? input.status : undefined;
  const rawTags = input.tags ?? input.labels;
  const tags = rawTags === undefined || rawTags === null ? undefined : normalizeTicketTags(rawTags);
  const projectId = input.project_id != null ? String(input.project_id).trim() : '';
  const maxRerun = Number(input.max_rerun_attempts);
  const rerunDelay = Number(input.rerun_delay_seconds);
  return {
    enabled: !!input.enabled,
    project_id: projectId || undefined,
    status,
    priority,
    assignee_runtime: input.assignee_runtime ? normalizeRuntimeSpec(input.assignee_runtime, 'Failure ticket runtime') : undefined,
    tags,
    dedupe,
    title_template: input.title_template ? String(input.title_template) : undefined,
    rerun_on_fix: input.rerun_on_fix === undefined ? undefined : !!input.rerun_on_fix,
    max_rerun_attempts: Number.isFinite(maxRerun) && maxRerun >= 0 ? Math.floor(maxRerun) : undefined,
    rerun_delay_seconds: Number.isFinite(rerunDelay) && rerunDelay >= 0 ? Math.floor(rerunDelay) : undefined,
    deployment_gate: input.deployment_gate === undefined ? undefined : !!input.deployment_gate,
  };
}

/**
 * List view-model: a QaScenario row enriched with a last-run rollup so the QA
 * dashboard can render a status table (last-run time + result + pass-rate)
 * without an N+1 fetch-runs-per-scenario. Computed in QaService.list via a
 * single qa_runs query keyed on the listed scenario ids.
 */
export interface QaScenarioListItem extends Omit<QaScenario, 'refreshRuntimeIdentity'> {
  last_run_at: string | null;
  last_run_status: QaRunStatus | null;
  /** Total retained runs for the scenario (bounded by max_runs). */
  run_count: number;
}

export interface CreateScenarioInput {
  account_id: string;
  name: string;
  description?: string;
  steps?: any;
  /** P4c-3b: target_agent_id / target_runtime 중 하나 필수 (service resolveTarget). */
  target_agent_id?: string;
  /**
   * P4c-3b: spec-direct target. Present → normalized, identity-keyed, and
   * authoritative (target_agent_id is set to the identity key). Absent →
   * legacy agent path (row looked up, snapshot dual-written).
   */
  target_runtime?: unknown;
  qa_driver?: string;
  qa_driver_config?: Record<string, any> | null;
  enabled?: boolean;
  tags?: any;
  on_failure_ticket?: any;
  created_by?: string;
  max_runs?: number;
  /** Working-folder options (shared with SecurityProfile). repo_ref is loose
   *  input normalized via normalizeRepoRef; the rest are normalized scalars. */
  workspace_folder?: string;
  repo_ref?: any;
  checkout_mode?: any;
  build_mode?: any;
  /** Build & Artifact Registry target (free-text platform/config selector). */
  build_target?: string;
  /** Deployment-awareness target environment (ticket 8ce72b18) — the
   *  Deployment.environment join key this scenario validates. '' = unset. */
  target_environment?: string;
  /** Pre-serialized LivenessPolicy JSON string (or null to clear). The MCP/REST
   *  layer validates + serializes via qa-liveness-policy before calling in. */
  liveness_policy?: string | null;
  /** Pre-serialized QaPhasesConfig JSON string (or null to clear).
   *  The MCP/REST layer validates + serializes via qa-phases before calling in. */
  qa_phases?: string | null;
}

/**
 * Owns QaScenario CRUD. Mirrors ActionsService's CRUD half (workspace scope
 * checks, target-agent validation). The Run dispatch + result recording live
 * in QaRunService.
 */
@Injectable()
export class QaService {
  constructor(
    @InjectRepository(QaScenario) private readonly scenarioRepo: Repository<QaScenario>,
    @InjectRepository(QaRun) private readonly runRepo: Repository<QaRun>,
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(RuntimeHost) private readonly hostRepo: Repository<RuntimeHost>,
    private readonly runService: QaRunService,
  ) {}

  async list(accountId: string): Promise<QaScenarioListItem[]> {
    if (!accountId) throw makeError(400, 'account_id is required');
    const qb = this.scenarioRepo.createQueryBuilder('s')
      .where('s.account_id = :ws', { ws: accountId });
    const scenarios = await qb.orderBy('s.name', 'ASC').getMany();
    return this._attachLastRun(scenarios);
  }

  /**
   * Fold each scenario's last-run summary in with ONE qa_runs query (no N+1).
   * We pull the retained runs (already FIFO-capped at max_runs) for the listed
   * scenario ids ordered created_at DESC, then reduce per scenario in JS — the
   * first row seen per scenario is its latest run. Using the entity `find`
   * (not raw SQL) keeps Date hydration + the result DB-agnostic across
   * SQLite(dev) and Postgres(prod); no DISTINCT ON / window-function syntax that
   * diverges between the two engines.
   */
  private async _attachLastRun(scenarios: QaScenario[]): Promise<QaScenarioListItem[]> {
    if (scenarios.length === 0) return [];
    const ids = scenarios.map((s) => s.id);
    const runs = await this.runRepo.find({
      where: { scenario_id: In(ids) },
      select: ['scenario_id', 'status', 'started_at', 'finished_at', 'created_at'],
      order: { created_at: 'DESC' },
    });

    type Agg = { latest: QaRun | null; count: number };
    const byScenario = new Map<string, Agg>();
    for (const r of runs) {
      let agg = byScenario.get(r.scenario_id);
      if (!agg) { agg = { latest: null, count: 0 }; byScenario.set(r.scenario_id, agg); }
      if (!agg.latest) agg.latest = r; // DESC order → first row per scenario is the latest.
      agg.count++;
    }

    return scenarios.map((s) => {
      const agg = byScenario.get(s.id);
      const latest = agg?.latest ?? null;
      const lastRunAt = latest ? (latest.finished_at ?? latest.started_at ?? latest.created_at) : null;
      return {
        ...s,
        last_run_at: lastRunAt ? new Date(lastRunAt).toISOString() : null,
        last_run_status: latest ? latest.status : null,
        run_count: agg ? agg.count : 0,
      };
    });
  }

  async get(id: string): Promise<QaScenario> {
    return findOrFail(this.scenarioRepo, { where: { id } }, 'QA scenario not found');
  }

  /**
   * P4c-3b: target resolution shared by create/update. Returns the stored
   * id + snapshot for EITHER input shape. Spec shape needs no Agent row —
   * dispatch resolves the identity key without one.
   */
  private async resolveTarget(
    accountId: string,
    targetAgentId: string | undefined,
    targetRuntime: unknown,
  ): Promise<{ target_agent_id: string; target_runtime: Record<string, any> | null }> {
    if (targetRuntime !== undefined && targetRuntime !== null) {
      let spec;
      try {
        spec = normalizeRuntimeSpec(targetRuntime, 'target_runtime');
      } catch (e: any) {
        throw makeError(400, e?.message || 'invalid target_runtime');
      }
      // P4c-4: Host 직접 조회 후 api_keys 페어링 링크 (Agent 테이블 없음).
      const hostRow = await this.hostRepo.findOne({ where: { id: spec.manager_agent_id } });
      if (!hostRow) {
        throw makeError(400, 'target_runtime references an unknown Runtime Host');
      }
      return { target_agent_id: runtimeIdentityKey(spec), target_runtime: { ...spec } };
    }
    throw makeError(400, 'target_runtime is required; Agent references are no longer supported');
  }

  async create(input: CreateScenarioInput): Promise<QaScenario> {
    if (!input.account_id) throw makeError(400, 'account_id is required');
    if (!input.name || !input.name.trim()) throw makeError(400, 'name is required');
    const target = await this.resolveTarget(input.account_id, input.target_agent_id, input.target_runtime);

    const created = this.scenarioRepo.create({
      account_id: input.account_id,
      name: input.name.trim(),
      description: input.description ?? '',
      steps: normalizeSteps(input.steps),
      target_agent_id: target.target_agent_id,
      target_runtime: target.target_runtime,
      qa_driver: input.qa_driver ?? '',
      qa_driver_config: input.qa_driver_config ?? null,
      enabled: input.enabled !== false,
      tags: normalizeTags(input.tags),
      on_failure_ticket: normalizeOnFailureTicket(input.on_failure_ticket),
      created_by: input.created_by ?? '',
      max_runs: typeof input.max_runs === 'number' && input.max_runs > 0 ? Math.floor(input.max_runs) : 20,
      workspace_folder: normalizeWorkspaceFolder(input.workspace_folder),
      build_target: normalizeBuildTarget(input.build_target),
      target_environment: (input.target_environment ?? '').trim(),
      repo_ref: normalizeRepoRef(input.repo_ref),
      checkout_mode: normalizeCheckoutMode(input.checkout_mode),
      build_mode: normalizeBuildMode(input.build_mode),
      // cold/warm state starts empty — advanced by the provisioner after a build.
      last_built_commit: null,
      built_at: null,
      liveness_policy: input.liveness_policy ?? null,
      qa_phases: input.qa_phases ?? null,
    });
    return this.scenarioRepo.save(created);
  }

  async update(id: string, accountId: string, patch: Partial<CreateScenarioInput>): Promise<QaScenario> {
    if (!accountId) throw makeError(400, 'account_id is required');
    const existing = await findOrFail(this.scenarioRepo, { where: { id, account_id: accountId } }, 'QA scenario not found in workspace');

    if (patch.name !== undefined) {
      if (!patch.name || !patch.name.trim()) throw makeError(400, 'name cannot be empty');
      existing.name = patch.name.trim();
    }
    if (patch.description !== undefined) existing.description = patch.description ?? '';
    if (patch.steps !== undefined) existing.steps = normalizeSteps(patch.steps);
    if (patch.target_agent_id !== undefined || patch.target_runtime !== undefined) {
      // P4c-3b: spec present → spec path (sets both columns); id-only → legacy.
      const target = await this.resolveTarget(
        accountId,
        patch.target_agent_id !== undefined ? patch.target_agent_id : existing.target_agent_id,
        patch.target_runtime,
      );
      existing.target_agent_id = target.target_agent_id;
      existing.target_runtime = target.target_runtime;
    }
    if (patch.qa_driver !== undefined) existing.qa_driver = patch.qa_driver ?? '';
    if (patch.qa_driver_config !== undefined) existing.qa_driver_config = patch.qa_driver_config ?? null;
    if (patch.enabled !== undefined) existing.enabled = !!patch.enabled;
    if (patch.tags !== undefined) existing.tags = normalizeTags(patch.tags);
    if (patch.on_failure_ticket !== undefined) existing.on_failure_ticket = normalizeOnFailureTicket(patch.on_failure_ticket);
    if (patch.max_runs !== undefined) {
      const n = Number(patch.max_runs);
      if (Number.isFinite(n) && n > 0) existing.max_runs = Math.floor(n);
    }
    // Working-folder options (normalized). Changing checkout/build/repo does NOT
    // reset last_built_commit here — the provisioner owns that state.
    if (patch.workspace_folder !== undefined) existing.workspace_folder = normalizeWorkspaceFolder(patch.workspace_folder);
    if (patch.build_target !== undefined) existing.build_target = normalizeBuildTarget(patch.build_target);
    if (patch.target_environment !== undefined) existing.target_environment = (patch.target_environment ?? '').trim();
    if (patch.repo_ref !== undefined) existing.repo_ref = normalizeRepoRef(patch.repo_ref);
    if (patch.checkout_mode !== undefined) existing.checkout_mode = normalizeCheckoutMode(patch.checkout_mode);
    if (patch.build_mode !== undefined) existing.build_mode = normalizeBuildMode(patch.build_mode);
    // liveness_policy arrives pre-validated + serialized (string) or null to clear.
    if (patch.liveness_policy !== undefined) existing.liveness_policy = patch.liveness_policy ?? null;
    // qa_phases arrives pre-validated + serialized (string) or null to clear.
    if (patch.qa_phases !== undefined) existing.qa_phases = patch.qa_phases ?? null;
    return this.scenarioRepo.save(existing);
  }

  async remove(id: string, accountId: string): Promise<void> {
    if (!accountId) throw makeError(400, 'account_id is required');
    const existing = await this.scenarioRepo.findOne({ where: { id, account_id: accountId } });
    if (!existing) throw makeError(404, 'QA scenario not found in workspace');
    // Cascade: tear down every run + the room each run created so the chat
    // list doesn't end up with orphan rooms pointing at a deleted scenario.
    await this.runService.deleteRunsForScenario(id);
    await this.scenarioRepo.delete({ id, account_id: accountId });
  }
}
