import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { BenchmarkScore } from '../../entities/BenchmarkScore';
import { Ticket } from '../../entities/Ticket';
import { Agent } from '../../entities/Agent';
import { resolveAgentDisplayMap } from '../../utils/agent-name';

/**
 * BenchmarkService — score persistence + leaderboard aggregation for the
 * benchmark feature (ticket 684c012b).
 *
 * Constructed two ways, matching the MCP ToolContext dual-path convention:
 *   1. NestJS DI (BenchmarkController, McpController) — DataSource injected.
 *   2. Standalone (`new BenchmarkService(dataSource)` in createStandaloneContext)
 *      — the service is stateless over the DataSource so a direct instantiation
 *      behaves identically to the DI singleton.
 *
 * Aggregation is done in-memory rather than as grouped SQL: benchmark runs are
 * small (a handful of candidates × evaluators × dimensions), and in-memory
 * folding keeps the logic DB-portable across sqlite/Postgres without dialect
 * quirks (AVG over float, GROUP BY on joined columns, etc.).
 */
/** One candidate's aggregated scores within a run leaderboard. */
export interface RunLeaderboardCandidate {
  candidate_ticket_id: string;
  title: string;
  assignee_agent_id: string;
  assignee_name: string;
  score_count: number;
  average: number | null;
  per_dimension: Array<{ dimension: string; average: number; count: number }>;
  scores: Array<{
    evaluator_agent_id: string;
    evaluator_name: string;
    dimension: string;
    score: number;
    rationale: string;
  }>;
}

@Injectable()
export class BenchmarkService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Insert or update a single evaluator score. Dedup key is
   * (candidate_ticket_id, evaluator_agent_id, dimension) — a re-score updates
   * the existing row instead of creating a duplicate, matching the entity's
   * unique constraint.
   *
   * `run_ticket_id` is derived from the candidate's parent (a candidate is a
   * child of its run). A root-level candidate (no parent) falls back to its own
   * id so the row is still self-consistent.
   */
  async upsertScore(input: {
    candidate_ticket_id: string;
    evaluator_agent_id: string;
    dimension: string;
    score: number;
    rationale?: string;
    run_ticket_id?: string;
  }): Promise<BenchmarkScore> {
    const candidateId = (input.candidate_ticket_id || '').trim();
    const evaluatorId = (input.evaluator_agent_id || '').trim();
    const dimension = (input.dimension || '').trim();
    if (!candidateId) throw Object.assign(new Error('candidate_ticket_id is required'), { status: 400 });
    if (!evaluatorId) throw Object.assign(new Error('evaluator_agent_id is required'), { status: 400 });
    if (!dimension) throw Object.assign(new Error('dimension is required'), { status: 400 });
    const score = Number(input.score);
    if (!Number.isFinite(score)) {
      throw Object.assign(new Error('score must be a finite number'), { status: 400 });
    }

    const ticketRepo = this.dataSource.getRepository(Ticket);
    const candidate = await ticketRepo.findOne({ where: { id: candidateId } });
    if (!candidate) {
      throw Object.assign(new Error(`Candidate ticket ${candidateId} not found`), { status: 404 });
    }
    // Run = candidate's parent (the run ticket holds the task). Explicit
    // override wins so a caller can pin the run when candidates are root-level.
    const runTicketId = (input.run_ticket_id || '').trim() || candidate.parent_id || candidate.id;

    const repo = this.dataSource.getRepository(BenchmarkScore);
    const existing = await repo.findOne({
      where: {
        candidate_ticket_id: candidateId,
        evaluator_agent_id: evaluatorId,
        dimension,
      },
    });
    if (existing) {
      existing.score = score;
      existing.rationale = input.rationale ?? '';
      existing.run_ticket_id = runTicketId;
      return repo.save(existing);
    }
    return repo.save(repo.create({
      run_ticket_id: runTicketId,
      candidate_ticket_id: candidateId,
      evaluator_agent_id: evaluatorId,
      dimension,
      score,
      rationale: input.rationale ?? '',
    }));
  }

  /**
   * Run leaderboard: every candidate under one run, with its per-dimension
   * averages, overall average, and the raw evaluator score breakdown. Candidates
   * are returned ranked by overall average (desc). Candidate titles + the agent
   * being benchmarked (the candidate's assignee) are resolved for display.
   */
  async getRunLeaderboard(runTicketId: string): Promise<{
    run_ticket_id: string;
    candidates: RunLeaderboardCandidate[];
  }> {
    const scoreRepo = this.dataSource.getRepository(BenchmarkScore);
    const rows = await scoreRepo.find({ where: { run_ticket_id: runTicketId } });

    const candidateIds = Array.from(new Set(rows.map(r => r.candidate_ticket_id)));
    const ticketRepo = this.dataSource.getRepository(Ticket);
    const candidates = candidateIds.length > 0
      ? await ticketRepo.createQueryBuilder('t').where('t.id IN (:...ids)', { ids: candidateIds }).getMany()
      : [];
    const candidateById = new Map(candidates.map(c => [c.id, c]));

    const nameById = await this._resolveAgentNames([
      ...rows.map(r => r.evaluator_agent_id),
      ...candidates.map(c => c.assignee_id).filter(Boolean) as string[],
    ]);

    const byCandidate = new Map<string, BenchmarkScore[]>();
    for (const r of rows) {
      const list = byCandidate.get(r.candidate_ticket_id) || [];
      list.push(r);
      byCandidate.set(r.candidate_ticket_id, list);
    }

    const out: RunLeaderboardCandidate[] = [];
    for (const cid of candidateIds) {
      const cscores = byCandidate.get(cid) || [];
      const ticket = candidateById.get(cid);
      const assigneeId = ticket?.assignee_id || '';
      out.push({
        candidate_ticket_id: cid,
        title: ticket?.title || '(unknown candidate)',
        assignee_agent_id: assigneeId,
        assignee_name: assigneeId ? (nameById.get(assigneeId) || assigneeId) : '',
        score_count: cscores.length,
        average: this._avg(cscores.map(s => s.score)),
        per_dimension: this._perDimension(cscores),
        scores: cscores.map(s => ({
          evaluator_agent_id: s.evaluator_agent_id,
          evaluator_name: nameById.get(s.evaluator_agent_id) || s.evaluator_agent_id,
          dimension: s.dimension,
          score: s.score,
          rationale: s.rationale,
        })),
      });
    }
    out.sort((a, b) => (b.average ?? -Infinity) - (a.average ?? -Infinity));
    return { run_ticket_id: runTicketId, candidates: out };
  }

  /**
   * Agent leaderboard: aggregate every score across runs by the AGENT BEING
   * BENCHMARKED — i.e. the candidate ticket's assignee, not the evaluator.
   * Optionally scoped to one workspace (candidate ticket's workspace_id).
   * Returned ranked by overall average (desc).
   */
  async getAgentLeaderboard(workspaceId?: string): Promise<{
    agents: Array<{
      agent_id: string;
      agent_name: string;
      candidate_count: number;
      score_count: number;
      average: number | null;
      per_dimension: Array<{ dimension: string; average: number; count: number }>;
    }>;
  }> {
    const scoreRepo = this.dataSource.getRepository(BenchmarkScore);
    const rows = await scoreRepo.find();
    if (rows.length === 0) return { agents: [] };

    const candidateIds = Array.from(new Set(rows.map(r => r.candidate_ticket_id)));
    const ticketRepo = this.dataSource.getRepository(Ticket);
    const candidates = await ticketRepo
      .createQueryBuilder('t')
      .where('t.id IN (:...ids)', { ids: candidateIds })
      .getMany();
    const candidateById = new Map(candidates.map(c => [c.id, c]));

    // Group scores by the candidate's assignee agent, dropping scores whose
    // candidate is missing/unassigned or out of the requested workspace.
    const byAgent = new Map<string, { scores: BenchmarkScore[]; candidates: Set<string> }>();
    for (const r of rows) {
      const ticket = candidateById.get(r.candidate_ticket_id);
      if (!ticket || !ticket.assignee_id) continue;
      if (workspaceId && ticket.workspace_id !== workspaceId) continue;
      const bucket = byAgent.get(ticket.assignee_id) || { scores: [], candidates: new Set<string>() };
      bucket.scores.push(r);
      bucket.candidates.add(r.candidate_ticket_id);
      byAgent.set(ticket.assignee_id, bucket);
    }

    const nameById = await this._resolveAgentNames(Array.from(byAgent.keys()));
    const agents = Array.from(byAgent.entries()).map(([agentId, b]) => ({
      agent_id: agentId,
      agent_name: nameById.get(agentId) || agentId,
      candidate_count: b.candidates.size,
      score_count: b.scores.length,
      average: this._avg(b.scores.map(s => s.score)),
      per_dimension: this._perDimension(b.scores),
    }));
    agents.sort((a, b) => (b.average ?? -Infinity) - (a.average ?? -Infinity));
    return { agents };
  }

  // ─── helpers ───────────────────────────────────────────────

  private _avg(nums: number[]): number | null {
    if (nums.length === 0) return null;
    const sum = nums.reduce((a, b) => a + b, 0);
    return Math.round((sum / nums.length) * 1000) / 1000;
  }

  private _perDimension(scores: BenchmarkScore[]): Array<{ dimension: string; average: number; count: number }> {
    const byDim = new Map<string, number[]>();
    for (const s of scores) {
      const list = byDim.get(s.dimension) || [];
      list.push(s.score);
      byDim.set(s.dimension, list);
    }
    return Array.from(byDim.entries())
      .map(([dimension, vals]) => ({ dimension, average: this._avg(vals) as number, count: vals.length }))
      .sort((a, b) => a.dimension.localeCompare(b.dimension));
  }

  private async _resolveAgentNames(agentIds: string[]): Promise<Map<string, string>> {
    const ids = Array.from(new Set(agentIds.filter(Boolean)));
    if (ids.length === 0) return new Map();
    const agentRepo = this.dataSource.getRepository(Agent);
    const agents = await agentRepo
      .createQueryBuilder('a')
      .where('a.id IN (:...ids)', { ids })
      .getMany();
    return resolveAgentDisplayMap(agentRepo, agents);
  }
}
