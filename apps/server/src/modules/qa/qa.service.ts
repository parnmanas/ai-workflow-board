import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { QaScenario, QaScenarioStep } from '../../entities/QaScenario';
import { QaRun, QaRunStatus } from '../../entities/QaRun';
import { Agent } from '../../entities/Agent';
import { Board } from '../../entities/Board';
import { findOrFail } from '../../common/find-or-fail';
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
 * List view-model: a QaScenario row enriched with a last-run rollup so the QA
 * dashboard can render a status table (last-run time + result + pass-rate)
 * without an N+1 fetch-runs-per-scenario. Computed in QaService.list via a
 * single qa_runs query keyed on the listed scenario ids.
 */
export interface QaScenarioListItem extends QaScenario {
  last_run_at: string | null;
  last_run_status: QaRunStatus | null;
  /** Pass ratio (0–100) over finished runs (passed/failed/error); null if none finished. */
  pass_rate: number | null;
  /** Total retained runs for the scenario (bounded by max_runs). */
  run_count: number;
}

export interface CreateScenarioInput {
  workspace_id: string;
  board_id?: string | null;
  name: string;
  description?: string;
  steps?: any;
  target_agent_id: string;
  qa_driver?: string;
  qa_driver_config?: Record<string, any> | null;
  enabled?: boolean;
  tags?: any;
  created_by?: string;
  max_runs?: number;
}

/**
 * Owns QaScenario CRUD. Mirrors ActionsService's CRUD half (workspace/board
 * scope checks, target-agent validation). The Run dispatch + result recording
 * live in QaRunService.
 */
@Injectable()
export class QaService {
  constructor(
    @InjectRepository(QaScenario) private readonly scenarioRepo: Repository<QaScenario>,
    @InjectRepository(QaRun) private readonly runRepo: Repository<QaRun>,
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
    @InjectRepository(Board) private readonly boardRepo: Repository<Board>,
    private readonly runService: QaRunService,
  ) {}

  async list(workspaceId: string, boardId: string | undefined): Promise<QaScenarioListItem[]> {
    if (!workspaceId) throw makeError(400, 'workspace_id is required');
    const qb = this.scenarioRepo.createQueryBuilder('s').where('s.workspace_id = :ws', { ws: workspaceId });
    if (boardId !== undefined) {
      // Mirror Actions/Resources scoping: '' = workspace-scope only (board_id
      // IS NULL), <uuid> = that board only, omit = all rows in the workspace.
      if (boardId) qb.andWhere('s.board_id = :bid', { bid: boardId });
      else qb.andWhere('s.board_id IS NULL');
    }
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

    type Agg = { latest: QaRun | null; passed: number; finished: number; count: number };
    const byScenario = new Map<string, Agg>();
    for (const r of runs) {
      let agg = byScenario.get(r.scenario_id);
      if (!agg) { agg = { latest: null, passed: 0, finished: 0, count: 0 }; byScenario.set(r.scenario_id, agg); }
      if (!agg.latest) agg.latest = r; // DESC order → first row per scenario is the latest.
      agg.count++;
      if (r.status === 'passed' || r.status === 'failed' || r.status === 'error') {
        agg.finished++;
        if (r.status === 'passed') agg.passed++;
      }
    }

    return scenarios.map((s) => {
      const agg = byScenario.get(s.id);
      const latest = agg?.latest ?? null;
      const lastRunAt = latest ? (latest.finished_at ?? latest.started_at ?? latest.created_at) : null;
      return {
        ...s,
        last_run_at: lastRunAt ? new Date(lastRunAt).toISOString() : null,
        last_run_status: latest ? latest.status : null,
        pass_rate: agg && agg.finished > 0 ? Math.round((agg.passed / agg.finished) * 100) : null,
        run_count: agg ? agg.count : 0,
      };
    });
  }

  async get(id: string): Promise<QaScenario> {
    return findOrFail(this.scenarioRepo, { where: { id } }, 'QA scenario not found');
  }

  async create(input: CreateScenarioInput): Promise<QaScenario> {
    if (!input.workspace_id) throw makeError(400, 'workspace_id is required');
    if (!input.name || !input.name.trim()) throw makeError(400, 'name is required');
    if (!input.target_agent_id) throw makeError(400, 'target_agent_id is required');

    const agent = await this.agentRepo.findOne({ where: { id: input.target_agent_id } });
    if (!agent) throw makeError(400, 'target agent not found');
    if (agent.workspace_id && agent.workspace_id !== input.workspace_id) {
      throw makeError(400, 'target agent belongs to a different workspace');
    }

    if (input.board_id) {
      const board = await this.boardRepo.findOne({ where: { id: input.board_id } });
      if (!board) throw makeError(400, 'board not found');
      if (board.workspace_id !== input.workspace_id) {
        throw makeError(400, 'board belongs to a different workspace');
      }
    }

    const created = this.scenarioRepo.create({
      workspace_id: input.workspace_id,
      board_id: input.board_id || null,
      name: input.name.trim(),
      description: input.description ?? '',
      steps: normalizeSteps(input.steps),
      target_agent_id: input.target_agent_id,
      qa_driver: input.qa_driver ?? '',
      qa_driver_config: input.qa_driver_config ?? null,
      enabled: input.enabled !== false,
      tags: normalizeTags(input.tags),
      created_by: input.created_by ?? '',
      max_runs: typeof input.max_runs === 'number' && input.max_runs > 0 ? Math.floor(input.max_runs) : 20,
    });
    return this.scenarioRepo.save(created);
  }

  async update(id: string, workspaceId: string, patch: Partial<CreateScenarioInput>): Promise<QaScenario> {
    if (!workspaceId) throw makeError(400, 'workspace_id is required');
    const existing = await findOrFail(this.scenarioRepo, { where: { id, workspace_id: workspaceId } }, 'QA scenario not found in workspace');

    if (patch.name !== undefined) {
      if (!patch.name || !patch.name.trim()) throw makeError(400, 'name cannot be empty');
      existing.name = patch.name.trim();
    }
    if (patch.description !== undefined) existing.description = patch.description ?? '';
    if (patch.steps !== undefined) existing.steps = normalizeSteps(patch.steps);
    if (patch.target_agent_id !== undefined) {
      const agent = await this.agentRepo.findOne({ where: { id: patch.target_agent_id } });
      if (!agent) throw makeError(400, 'target agent not found');
      if (agent.workspace_id && agent.workspace_id !== workspaceId) {
        throw makeError(400, 'target agent belongs to a different workspace');
      }
      existing.target_agent_id = patch.target_agent_id;
    }
    if (patch.board_id !== undefined) {
      if (patch.board_id) {
        const board = await this.boardRepo.findOne({ where: { id: patch.board_id } });
        if (!board) throw makeError(400, 'board not found');
        if (board.workspace_id !== workspaceId) {
          throw makeError(400, 'board belongs to a different workspace');
        }
      }
      existing.board_id = patch.board_id || null;
    }
    if (patch.qa_driver !== undefined) existing.qa_driver = patch.qa_driver ?? '';
    if (patch.qa_driver_config !== undefined) existing.qa_driver_config = patch.qa_driver_config ?? null;
    if (patch.enabled !== undefined) existing.enabled = !!patch.enabled;
    if (patch.tags !== undefined) existing.tags = normalizeTags(patch.tags);
    if (patch.max_runs !== undefined) {
      const n = Number(patch.max_runs);
      if (Number.isFinite(n) && n > 0) existing.max_runs = Math.floor(n);
    }
    return this.scenarioRepo.save(existing);
  }

  async remove(id: string, workspaceId: string): Promise<void> {
    if (!workspaceId) throw makeError(400, 'workspace_id is required');
    const existing = await this.scenarioRepo.findOne({ where: { id, workspace_id: workspaceId } });
    if (!existing) throw makeError(404, 'QA scenario not found in workspace');
    // Cascade: tear down every run + the room each run created so the chat
    // list doesn't end up with orphan rooms pointing at a deleted scenario.
    await this.runService.deleteRunsForScenario(id);
    await this.scenarioRepo.delete({ id, workspace_id: workspaceId });
  }
}
