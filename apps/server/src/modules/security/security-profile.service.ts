import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { SecurityProfile, SecurityChecklistItem, SecurityScopeMode } from '../../entities/SecurityProfile';
import { SecurityRun, SecurityRunStatus } from '../../entities/SecurityRun';
import { Agent } from '../../entities/Agent';
import { Board } from '../../entities/Board';
import { findOrFail } from '../../common/find-or-fail';
import { SecurityRunService } from './security-run.service';

function makeError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

const VALID_SEVERITY_HINTS = ['critical', 'high', 'medium', 'low', 'info'];

/**
 * Normalize the loose `checklist` input into a clean array. `source` (evidence
 * link / CVE-GHSA id) and `added_at` (freshness stamp) are carried through —
 * `added_at` is preserved when the caller supplies it (so re-saving an existing
 * checklist doesn't reset the freshness of older items) and stamped to "now"
 * when missing (newly refreshed / seeded items get a real entry time).
 */
function normalizeChecklist(checklist: any): SecurityChecklistItem[] {
  if (!Array.isArray(checklist)) return [];
  const now = new Date().toISOString();
  return checklist.map((c, i) => {
    const item: SecurityChecklistItem = {
      id: c?.id ? String(c.id) : `item-${i}`,
      title: String(c?.title ?? ''),
    };
    if (c?.category != null) item.category = String(c.category);
    if (VALID_SEVERITY_HINTS.includes(c?.severity_hint)) item.severity_hint = c.severity_hint;
    if (c?.guidance != null) item.guidance = String(c.guidance);
    if (c?.source != null && String(c.source).trim()) item.source = String(c.source).trim();
    item.added_at = c?.added_at != null && String(c.added_at).trim() ? String(c.added_at).trim() : now;
    return item;
  });
}

function normalizeTags(tags: any): string[] {
  if (!Array.isArray(tags)) return [];
  return tags.map((t) => String(t)).filter(Boolean);
}

function normalizeScopeMode(mode: any): SecurityScopeMode {
  return mode === 'full' ? 'full' : 'incremental';
}

/**
 * List view-model: a SecurityProfile row enriched with a last-run rollup so the
 * security dashboard can render a status table (last-run time + result + open
 * finding count) without an N+1 fetch-runs-per-profile. Computed via a single
 * security_runs query keyed on the listed profile ids.
 */
export interface SecurityProfileListItem extends SecurityProfile {
  last_run_at: string | null;
  last_run_status: SecurityRunStatus | null;
  last_scope_used: SecurityScopeMode | null;
  /** Total retained runs for the profile (bounded by max_runs). */
  run_count: number;
}

export interface CreateProfileInput {
  workspace_id: string;
  board_id?: string | null;
  name: string;
  description?: string;
  checklist?: any;
  target_agent_id: string;
  target_resource_id?: string | null;
  scan_driver?: string;
  scan_driver_config?: Record<string, any> | null;
  scope_mode?: any;
  enabled?: boolean;
  tags?: any;
  max_runs?: number;
  created_by?: string;
}

/**
 * Owns SecurityProfile CRUD. Mirrors QaService's CRUD half (workspace/board
 * scope checks, target-agent validation). Run dispatch + finding recording live
 * in SecurityRunService.
 */
@Injectable()
export class SecurityProfileService {
  constructor(
    @InjectRepository(SecurityProfile) private readonly profileRepo: Repository<SecurityProfile>,
    @InjectRepository(SecurityRun) private readonly runRepo: Repository<SecurityRun>,
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
    @InjectRepository(Board) private readonly boardRepo: Repository<Board>,
    private readonly runService: SecurityRunService,
  ) {}

  async list(workspaceId: string, boardId: string | undefined): Promise<SecurityProfileListItem[]> {
    if (!workspaceId) throw makeError(400, 'workspace_id is required');
    const qb = this.profileRepo.createQueryBuilder('p').where('p.workspace_id = :ws', { ws: workspaceId });
    if (boardId !== undefined) {
      // Mirror QA/Actions/Resources scoping: '' = workspace-scope only
      // (board_id IS NULL), <uuid> = that board only, omit = all rows.
      if (boardId) qb.andWhere('p.board_id = :bid', { bid: boardId });
      else qb.andWhere('p.board_id IS NULL');
    }
    const profiles = await qb.orderBy('p.name', 'ASC').getMany();
    return this._attachLastRun(profiles);
  }

  /**
   * Fold each profile's last-run summary in with ONE security_runs query (no
   * N+1). Pull the retained runs (already FIFO-capped) for the listed profile
   * ids ordered created_at DESC, then reduce per profile in JS — the first row
   * seen per profile is its latest run. The lean `select` deliberately omits the
   * (potentially large) `findings` JSON. Using the entity `find` (not raw SQL)
   * keeps Date hydration + the result DB-agnostic across SQLite(dev) and
   * Postgres(prod) — no DISTINCT ON / window-function dialect divergence.
   */
  private async _attachLastRun(profiles: SecurityProfile[]): Promise<SecurityProfileListItem[]> {
    if (profiles.length === 0) return [];
    const ids = profiles.map((p) => p.id);
    const runs = await this.runRepo.find({
      where: { profile_id: In(ids) },
      select: ['profile_id', 'status', 'scope_used', 'started_at', 'finished_at', 'created_at'],
      order: { created_at: 'DESC' },
    });

    type Agg = { latest: SecurityRun | null; count: number };
    const byProfile = new Map<string, Agg>();
    for (const r of runs) {
      let agg = byProfile.get(r.profile_id);
      if (!agg) { agg = { latest: null, count: 0 }; byProfile.set(r.profile_id, agg); }
      if (!agg.latest) agg.latest = r; // DESC order → first row per profile is the latest.
      agg.count++;
    }

    return profiles.map((p) => {
      const agg = byProfile.get(p.id);
      const latest = agg?.latest ?? null;
      const lastRunAt = latest ? (latest.finished_at ?? latest.started_at ?? latest.created_at) : null;
      return {
        ...p,
        last_run_at: lastRunAt ? new Date(lastRunAt).toISOString() : null,
        last_run_status: latest ? latest.status : null,
        last_scope_used: latest ? latest.scope_used : null,
        run_count: agg ? agg.count : 0,
      };
    });
  }

  async get(id: string): Promise<SecurityProfile> {
    return findOrFail(this.profileRepo, { where: { id } }, 'security profile not found');
  }

  async create(input: CreateProfileInput): Promise<SecurityProfile> {
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

    const created = this.profileRepo.create({
      workspace_id: input.workspace_id,
      board_id: input.board_id || null,
      name: input.name.trim(),
      description: input.description ?? '',
      checklist: normalizeChecklist(input.checklist),
      target_agent_id: input.target_agent_id,
      target_resource_id: input.target_resource_id || null,
      scan_driver: input.scan_driver ?? 'code-review',
      scan_driver_config: input.scan_driver_config ?? null,
      scope_mode: normalizeScopeMode(input.scope_mode),
      last_passed_commit: null,
      enabled: input.enabled !== false,
      tags: normalizeTags(input.tags),
      max_runs: typeof input.max_runs === 'number' && input.max_runs > 0 ? Math.floor(input.max_runs) : 20,
      created_by: input.created_by ?? '',
    });
    return this.profileRepo.save(created);
  }

  async update(id: string, workspaceId: string, patch: Partial<CreateProfileInput> & { last_passed_commit?: string | null }): Promise<SecurityProfile> {
    if (!workspaceId) throw makeError(400, 'workspace_id is required');
    const existing = await findOrFail(this.profileRepo, { where: { id, workspace_id: workspaceId } }, 'security profile not found in workspace');

    if (patch.name !== undefined) {
      if (!patch.name || !patch.name.trim()) throw makeError(400, 'name cannot be empty');
      existing.name = patch.name.trim();
    }
    if (patch.description !== undefined) existing.description = patch.description ?? '';
    if (patch.checklist !== undefined) existing.checklist = normalizeChecklist(patch.checklist);
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
    if (patch.target_resource_id !== undefined) existing.target_resource_id = patch.target_resource_id || null;
    if (patch.scan_driver !== undefined) existing.scan_driver = patch.scan_driver ?? 'code-review';
    if (patch.scan_driver_config !== undefined) existing.scan_driver_config = patch.scan_driver_config ?? null;
    if (patch.scope_mode !== undefined) existing.scope_mode = normalizeScopeMode(patch.scope_mode);
    // last_passed_commit is normally advanced by completeRun, but allow an
    // explicit reset (e.g. force a full re-scan by clearing the baseline).
    if (patch.last_passed_commit !== undefined) existing.last_passed_commit = patch.last_passed_commit || null;
    if (patch.enabled !== undefined) existing.enabled = !!patch.enabled;
    if (patch.tags !== undefined) existing.tags = normalizeTags(patch.tags);
    if (patch.max_runs !== undefined) {
      const n = Number(patch.max_runs);
      if (Number.isFinite(n) && n > 0) existing.max_runs = Math.floor(n);
    }
    return this.profileRepo.save(existing);
  }

  async remove(id: string, workspaceId: string): Promise<void> {
    if (!workspaceId) throw makeError(400, 'workspace_id is required');
    const existing = await this.profileRepo.findOne({ where: { id, workspace_id: workspaceId } });
    if (!existing) throw makeError(404, 'security profile not found in workspace');
    // Cascade: tear down every run + the room each run created so the chat list
    // doesn't end up with orphan rooms pointing at a deleted profile.
    await this.runService.deleteRunsForProfile(id);
    await this.profileRepo.delete({ id, workspace_id: workspaceId });
  }
}
