import { Injectable, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { BenchmarkScore } from '../../entities/BenchmarkScore';
import { Ticket } from '../../entities/Ticket';
import { Agent } from '../../entities/Agent';
import { Board } from '../../entities/Board';
import { BoardColumn } from '../../entities/BoardColumn';
import { resolveAgentDisplayMap } from '../../utils/agent-name';
import { ActivityService } from '../../services/activity.service';
import { LogService } from '../../services/log.service';
import { TriggerLoopService } from '../agents/trigger-loop.service';
import { TicketRoleAssignmentService } from '../workspace-roles/ticket-role-assignment.service';

// ─── Run lifecycle labels (ticket 5eb459c4) ───────────────────
// Run state lives on the run ticket's `labels` (a JSON-array field already wired
// end-to-end) — no schema change. `benchmark-run` marks a run; `benchmark-draft`
// present ⇒ draft, absent ⇒ started (so legacy runs created before this feature,
// which never carried the draft label, read as started — backward compatible).
const LABEL_BENCHMARK = 'benchmark';
const LABEL_RUN = 'benchmark-run';
const LABEL_DRAFT = 'benchmark-draft';
const LABEL_CANDIDATE = 'benchmark-candidate';
const PREFIX_STARTED = 'benchmark-started:'; // benchmark-started:<epochMs>
const PREFIX_CANDCOL = 'benchmark-candcol:'; // benchmark-candcol:<columnId>
const PREFIX_EVALUATOR = 'evaluator:'; // evaluator:<agentId>

/** Build an Error carrying an HTTP status so the REST/MCP layers can map it. */
function httpError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

/** Set-equality over two id lists (order/duplicates ignored). */
function sameSet(a: string[], b: string[]): boolean {
  const sa = new Set((a || []).filter(Boolean));
  const sb = new Set((b || []).filter(Boolean));
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

/** Actor (creator / starter) identity threaded through lifecycle writes. */
export interface RunActor {
  id?: string;
  name?: string;
  type?: 'user' | 'agent';
}

/** One candidate row in a run detail (edit-form prefill). */
export interface RunDetailCandidate {
  candidate_ticket_id: string;
  assignee_agent_id: string;
  assignee_name: string;
  title: string;
  /** Parked (draft, not yet dispatched) when true. */
  pending: boolean;
  column_id: string;
}

/** Full run state for the edit form + lifecycle responses. */
export interface RunDetail {
  run_ticket_id: string;
  title: string;
  state: 'draft' | 'started';
  started_at: number | null;
  board_id: string;
  workspace_id: string;
  run_column_id: string;
  candidate_column_id: string;
  prompt: string;
  rubric: string;
  base_repo: string;
  evaluator_agent_ids: string[];
  evaluators: Array<{ agent_id: string; name: string }>;
  candidates: RunDetailCandidate[];
}

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
  // The DataSource is the only hard dependency (score persistence + leaderboard
  // aggregation are stateless over it). The four lifecycle collaborators are
  // @Optional() so the standalone `new BenchmarkService(dataSource)` path in
  // createStandaloneContext keeps working — every method that uses them guards
  // on presence and degrades (no dispatch / no activity log) when absent, which
  // matches the standalone MCP server's behaviour (no live agent sessions to
  // push to anyway).
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Optional() private readonly triggerLoop?: TriggerLoopService,
    @Optional() private readonly roleAssignments?: TicketRoleAssignmentService,
    @Optional() private readonly activityService?: ActivityService,
    @Optional() private readonly logService?: LogService,
  ) {}

  // ─── Run lifecycle (ticket 5eb459c4) ───────────────────────
  // Option A editing policy:
  //   draft   → prompt/rubric/base/evaluators/candidates/column all editable.
  //   started → fairness lock: only candidate ADD (+ title) allowed; the server
  //             rejects prompt/rubric/base/evaluator changes + candidate removal
  //             + column changes with HTTP 422.

  /**
   * Create a DRAFT run: a parent run ticket plus one parked candidate child per
   * agent. Candidates are created with `pending_user_action=true` so the trigger
   * loop drops their dispatch (dispatchCurrentColumn skips pending tickets) —
   * they sit idle until startRun() clears the flag and wakes them. Unlike the
   * legacy create_benchmark_run, NOTHING is dispatched here.
   */
  async createDraftRun(input: {
    board_id: string;
    prompt: string;
    candidate_agent_ids?: string[];
    title?: string;
    rubric?: string;
    base_repo?: string;
    evaluator_agent_ids?: string[];
    candidate_column_name?: string;
    actor?: RunActor;
  }): Promise<RunDetail> {
    const boardId = (input.board_id || '').trim();
    if (!boardId) throw httpError('board_id is required', 400);
    const prompt = input.prompt || '';
    if (!prompt.trim()) throw httpError('prompt is required', 400);

    const candidateAgentIds = (input.candidate_agent_ids || []).filter(Boolean);
    const evaluatorIds = (input.evaluator_agent_ids || []).filter(Boolean);

    const { board, runColumn, candidateColumn } = await this._resolveRunColumns(boardId, input.candidate_column_name);
    const workspaceId = board.workspace_id || '';

    const ticketRepo = this.dataSource.getRepository(Ticket);
    const description = this._composeRunDescription(prompt, input.rubric, input.base_repo);
    const runLabels = [
      LABEL_BENCHMARK, LABEL_RUN, LABEL_DRAFT,
      `${PREFIX_CANDCOL}${candidateColumn.id}`,
      ...evaluatorIds.map((id) => `${PREFIX_EVALUATOR}${id}`),
    ];

    const creatorName = input.actor?.name || '';
    const creatorId = input.actor?.id || '';
    const runPosition = await ticketRepo
      .createQueryBuilder('t')
      .where('t.column_id = :colId AND t.parent_id IS NULL', { colId: runColumn.id })
      .getCount();
    const run = await ticketRepo.save(ticketRepo.create({
      column_id: runColumn.id,
      parent_id: null as any,
      depth: 0,
      title: input.title || 'Benchmark run',
      description,
      priority: 'high',
      workspace_id: workspaceId,
      labels: JSON.stringify(runLabels),
      position: runPosition,
      created_by: creatorName,
      created_by_type: input.actor?.type || (creatorId ? 'agent' : ''),
      created_by_id: creatorId,
    }));

    await this._createCandidateTickets(run.id, candidateAgentIds, {
      columnId: candidateColumn.id, workspaceId, prompt, parked: true, actor: input.actor,
    });
    await this._logRunActivity(run.id, run.title, creatorName);
    return this.getRunDetail(run.id);
  }

  /**
   * Start a draft run: flip its state to started and dispatch every parked
   * candidate via dispatchCurrentColumn — the exact wake path the legacy
   * create_benchmark_run used. Rejects if the run is already started (409).
   */
  async startRun(runId: string, actor?: RunActor): Promise<RunDetail> {
    const run = await this._loadRun(runId);
    if (!this._parseLabels(run.labels).includes(LABEL_DRAFT)) {
      throw httpError('Run is already started', 409);
    }
    await this._startRunInternal(run, 'benchmark_start', actor);
    return this.getRunDetail(runId);
  }

  /**
   * Backward-compatible one-shot used by the MCP `create_benchmark_run` tool:
   * create a run + candidates and start it immediately (the pre-lifecycle
   * behaviour). Returns the legacy fan-out shape — including the per-candidate
   * `dispatched` count and the `benchmark_candidate` trigger source the existing
   * benchmark-dispatch QA flow asserts on.
   */
  async createRunAndStart(input: {
    board_id: string;
    prompt: string;
    candidate_agent_ids?: string[];
    title?: string;
    rubric?: string;
    base_repo?: string;
    evaluator_agent_ids?: string[];
    candidate_column_name?: string;
    actor?: RunActor;
  }): Promise<{
    run_ticket_id: string;
    run_column_id: string;
    candidate_column_id: string;
    evaluator_agent_ids: string[];
    candidates: Array<{ candidate_ticket_id: string; assignee_agent_id: string; title: string; dispatched: number }>;
  }> {
    const detail = await this.createDraftRun(input);
    const run = await this._loadRun(detail.run_ticket_id);
    const counts = await this._startRunInternal(run, 'benchmark_candidate', input.actor);
    return {
      run_ticket_id: detail.run_ticket_id,
      run_column_id: detail.run_column_id,
      candidate_column_id: detail.candidate_column_id,
      evaluator_agent_ids: detail.evaluator_agent_ids,
      candidates: detail.candidates.map((c) => ({
        candidate_ticket_id: c.candidate_ticket_id,
        assignee_agent_id: c.assignee_agent_id,
        title: c.title,
        dispatched: counts.get(c.candidate_ticket_id) || 0,
      })),
    };
  }

  /**
   * Flip a draft run to started and dispatch each candidate, returning a
   * per-candidate emitted-trigger count. Caller must ensure the run is a draft.
   */
  private async _startRunInternal(run: Ticket, source: string, actor?: RunActor): Promise<Map<string, number>> {
    const ticketRepo = this.dataSource.getRepository(Ticket);
    const labels = this._parseLabels(run.labels);
    const next = labels.filter((l) => l !== LABEL_DRAFT && !l.startsWith(PREFIX_STARTED));
    next.push(`${PREFIX_STARTED}${Date.now()}`);
    run.labels = JSON.stringify(next);
    await ticketRepo.save(run);

    const counts = new Map<string, number>();
    const children = await ticketRepo.find({ where: { parent_id: run.id } });
    for (const child of children) {
      if (!this._isCandidate(child)) continue;
      if (child.pending_user_action) {
        child.pending_user_action = false;
        child.pending_reason = '';
        await ticketRepo.save(child);
      }
      const emitted = await this._dispatchCandidate(child.id, source, actor?.id || '');
      counts.set(child.id, emitted);
    }
    return counts;
  }

  /**
   * Edit a run under the Option-A policy. In started state only candidate
   * additions (+ title) pass; every other mutation throws 422. In draft state
   * everything is editable: description (prompt/rubric/base), evaluator set,
   * candidate column, and the candidate set (add + remove children).
   */
  async updateRun(runId: string, patch: {
    title?: string;
    prompt?: string;
    rubric?: string;
    base_repo?: string;
    evaluator_agent_ids?: string[];
    candidate_agent_ids?: string[];
    candidate_column_name?: string;
  }, actor?: RunActor): Promise<RunDetail> {
    const ticketRepo = this.dataSource.getRepository(Ticket);
    const run = await this._loadRun(runId);
    const labels = this._parseLabels(run.labels);
    const state = this._runStateFromLabels(labels);
    const current = this._parseRunDescription(run.description || '');
    const currentEvaluators = labels
      .filter((l) => l.startsWith(PREFIX_EVALUATOR))
      .map((l) => l.slice(PREFIX_EVALUATOR.length));
    const boardId = await this._runBoardId(run);

    if (state === 'started') {
      if (patch.prompt !== undefined && patch.prompt !== current.prompt) {
        throw httpError('Cannot change the prompt after the run has started', 422);
      }
      if (patch.rubric !== undefined && patch.rubric !== current.rubric) {
        throw httpError('Cannot change the rubric after the run has started', 422);
      }
      if (patch.base_repo !== undefined && patch.base_repo !== current.base_repo) {
        throw httpError('Cannot change the base repository after the run has started', 422);
      }
      if (patch.candidate_column_name !== undefined) {
        throw httpError('Cannot change the candidate column after the run has started', 422);
      }
      if (patch.evaluator_agent_ids !== undefined && !sameSet(patch.evaluator_agent_ids, currentEvaluators)) {
        throw httpError('Cannot change evaluators after the run has started', 422);
      }
      if (patch.candidate_agent_ids !== undefined) {
        const existing = await this._candidateAssigneeIds(runId);
        const requested = patch.candidate_agent_ids.filter(Boolean);
        const removed = existing.filter((id) => !requested.includes(id));
        if (removed.length > 0) {
          throw httpError('Cannot remove candidates after the run has started — only additions are allowed', 422);
        }
        const added = requested.filter((id) => !existing.includes(id));
        if (added.length > 0) await this.addCandidates(runId, added, actor);
      }
      if (patch.title !== undefined && patch.title.trim()) {
        run.title = patch.title;
        await ticketRepo.save(run);
      }
      return this.getRunDetail(runId);
    }

    // ─── draft: free edit ───
    const nextPrompt = patch.prompt !== undefined ? patch.prompt : current.prompt;
    const nextRubric = patch.rubric !== undefined ? patch.rubric : current.rubric;
    const nextBase = patch.base_repo !== undefined ? patch.base_repo : current.base_repo;
    if (patch.prompt !== undefined || patch.rubric !== undefined || patch.base_repo !== undefined) {
      run.description = this._composeRunDescription(nextPrompt, nextRubric, nextBase);
    }
    if (patch.title !== undefined && patch.title.trim()) run.title = patch.title;

    let next = [...labels];
    if (patch.evaluator_agent_ids !== undefined) {
      next = next
        .filter((l) => !l.startsWith(PREFIX_EVALUATOR))
        .concat(patch.evaluator_agent_ids.filter(Boolean).map((id) => `${PREFIX_EVALUATOR}${id}`));
    }
    let candidateColumnId = this._candcolFromLabels(labels);
    if (patch.candidate_column_name !== undefined) {
      const { candidateColumn } = await this._resolveRunColumns(boardId, patch.candidate_column_name);
      candidateColumnId = candidateColumn.id;
      next = next.filter((l) => !l.startsWith(PREFIX_CANDCOL)).concat([`${PREFIX_CANDCOL}${candidateColumn.id}`]);
    }
    if (!candidateColumnId) {
      candidateColumnId = (await this._resolveRunColumns(boardId)).candidateColumn.id;
    }
    run.labels = JSON.stringify(next);
    await ticketRepo.save(run);

    // Candidate set diff (draft only — add + remove children).
    if (patch.candidate_agent_ids !== undefined) {
      const requested = patch.candidate_agent_ids.filter(Boolean);
      const children = await ticketRepo.find({ where: { parent_id: runId } });
      const candChildren = children.filter((c) => this._isCandidate(c));
      const existingByAgent = new Set(candChildren.map((c) => c.assignee_id).filter(Boolean));
      for (const c of candChildren) {
        if (!requested.includes(c.assignee_id)) await ticketRepo.delete(c.id);
      }
      const toAdd = requested.filter((id) => !existingByAgent.has(id));
      if (toAdd.length) {
        await this._createCandidateTickets(runId, toAdd, {
          columnId: candidateColumnId, workspaceId: run.workspace_id, prompt: nextPrompt, parked: true, actor,
        });
      }
    }

    // A draft prompt edit must propagate to the candidate children (their
    // description mirrors the run prompt — that's the task each candidate works).
    if (patch.prompt !== undefined && patch.candidate_agent_ids === undefined) {
      const children = await ticketRepo.find({ where: { parent_id: runId } });
      for (const c of children) {
        if (!this._isCandidate(c)) continue;
        c.description = nextPrompt;
        await ticketRepo.save(c);
      }
    }
    return this.getRunDetail(runId);
  }

  /**
   * Add candidate children to a run. Allowed in both states (the only mutation
   * a started run permits). Draft → parked; started → dispatched immediately.
   * Agents already present as candidates are skipped (no duplicates).
   */
  async addCandidates(runId: string, agentIds: string[], actor?: RunActor): Promise<RunDetail> {
    const clean = (agentIds || []).filter(Boolean);
    if (clean.length === 0) throw httpError('candidate_agent_ids is required', 400);
    const run = await this._loadRun(runId);
    const labels = this._parseLabels(run.labels);
    const state = this._runStateFromLabels(labels);
    const boardId = await this._runBoardId(run);

    const existing = await this._candidateAssigneeIds(runId);
    const toAdd = clean.filter((id) => !existing.includes(id));
    let columnId = this._candcolFromLabels(labels);
    if (!columnId) columnId = (await this._resolveRunColumns(boardId)).candidateColumn.id;

    if (toAdd.length) {
      await this._createCandidateTickets(runId, toAdd, {
        columnId,
        workspaceId: run.workspace_id,
        prompt: this._parseRunDescription(run.description || '').prompt,
        parked: state === 'draft',
        actor,
      });
    }
    return this.getRunDetail(runId);
  }

  /** Full run state for the edit form (prefill) + lifecycle responses. */
  async getRunDetail(runId: string): Promise<RunDetail> {
    const run = await this._loadRun(runId);
    const labels = this._parseLabels(run.labels);
    const state = this._runStateFromLabels(labels);
    const startedLabel = labels.find((l) => l.startsWith(PREFIX_STARTED));
    const started_at = startedLabel ? (Number(startedLabel.slice(PREFIX_STARTED.length)) || null) : null;
    const evaluatorIds = labels.filter((l) => l.startsWith(PREFIX_EVALUATOR)).map((l) => l.slice(PREFIX_EVALUATOR.length));
    const candcol = this._candcolFromLabels(labels);
    const { prompt, rubric, base_repo } = this._parseRunDescription(run.description || '');
    const boardId = await this._runBoardId(run);

    const ticketRepo = this.dataSource.getRepository(Ticket);
    const children = await ticketRepo.find({ where: { parent_id: runId }, order: { position: 'ASC' } });
    const candChildren = children.filter((c) => this._isCandidate(c));
    const nameById = await this._resolveAgentNames([
      ...evaluatorIds,
      ...candChildren.map((c) => c.assignee_id).filter(Boolean),
    ]);

    return {
      run_ticket_id: run.id,
      title: run.title,
      state,
      started_at,
      board_id: boardId,
      workspace_id: run.workspace_id,
      run_column_id: run.column_id,
      candidate_column_id: candcol,
      prompt,
      rubric,
      base_repo,
      evaluator_agent_ids: evaluatorIds,
      evaluators: evaluatorIds.map((id) => ({ agent_id: id, name: nameById.get(id) || id })),
      candidates: candChildren.map((c) => ({
        candidate_ticket_id: c.id,
        assignee_agent_id: c.assignee_id,
        assignee_name: nameById.get(c.assignee_id) || c.assignee || c.assignee_id,
        title: c.title,
        pending: !!c.pending_user_action,
        column_id: c.column_id,
      })),
    };
  }

  // ─── lifecycle helpers ─────────────────────────────────────

  private async _createCandidateTickets(
    runId: string,
    agentIds: string[],
    opts: { columnId: string; workspaceId: string; prompt: string; parked: boolean; actor?: RunActor },
  ): Promise<Array<{ candidate_ticket_id: string; assignee_agent_id: string; title: string; dispatched: number }>> {
    const agentRepo = this.dataSource.getRepository(Agent);
    const ticketRepo = this.dataSource.getRepository(Ticket);
    let childPos = await ticketRepo
      .createQueryBuilder('t')
      .where('t.parent_id = :pid', { pid: runId })
      .getCount();

    const out: Array<{ candidate_ticket_id: string; assignee_agent_id: string; title: string; dispatched: number }> = [];
    for (const agentId of agentIds) {
      const agent = await agentRepo.findOne({ where: { id: agentId } });
      const agentName = agent?.name || agentId;
      const child = await ticketRepo.save(ticketRepo.create({
        parent_id: runId,
        depth: 1,
        column_id: opts.columnId,
        title: `Candidate: ${agentName}`,
        description: opts.prompt,
        priority: 'medium',
        status: 'todo',
        workspace_id: opts.workspaceId,
        assignee_id: agentId,
        assignee: agentName,
        labels: JSON.stringify([LABEL_BENCHMARK, LABEL_CANDIDATE]),
        position: childPos++,
        // Parked candidates are gated by pending_user_action: dispatchCurrentColumn
        // (and every other trigger path) drops triggers for pending tickets, so
        // the candidate sits idle on the active column until startRun clears it.
        pending_user_action: opts.parked,
        pending_reason: opts.parked ? 'Benchmark draft — awaiting Start' : '',
        pending_set_by: opts.parked ? (opts.actor?.id || 'benchmark') : '',
        created_by: opts.actor?.name || '',
        created_by_type: opts.actor?.type || (opts.actor?.id ? 'agent' : ''),
        created_by_id: opts.actor?.id || '',
      }));
      if (this.roleAssignments && opts.workspaceId) {
        try {
          await this.roleAssignments.syncBuiltinTrio(child.id, opts.workspaceId, { assignee_id: agentId });
        } catch (e) {
          this.logService?.warn('Benchmark', `createCandidate: role sync failed for ${child.id}: ${String(e)}`);
        }
      }
      let dispatched = 0;
      if (!opts.parked) {
        dispatched = await this._dispatchCandidate(child.id, 'benchmark_candidate', opts.actor?.id || '');
      }
      out.push({ candidate_ticket_id: child.id, assignee_agent_id: agentId, title: child.title, dispatched });
    }
    return out;
  }

  private async _dispatchCandidate(candidateId: string, source: string, actorId: string): Promise<number> {
    if (!this.triggerLoop) return 0;
    try {
      const res = await this.triggerLoop.dispatchCurrentColumn(candidateId, source, actorId);
      return res?.emitted || 0;
    } catch (e) {
      this.logService?.warn('Benchmark', `dispatch failed for candidate ${candidateId}: ${String(e)}`);
      return 0;
    }
  }

  private async _loadRun(runId: string): Promise<Ticket> {
    const id = (runId || '').trim();
    if (!id) throw httpError('run id is required', 400);
    const run = await this.dataSource.getRepository(Ticket).findOne({ where: { id } });
    if (!run) throw httpError(`Run ${id} not found`, 404);
    if (!this._parseLabels(run.labels).includes(LABEL_RUN)) {
      throw httpError(`Ticket ${id} is not a benchmark run`, 400);
    }
    return run;
  }

  private async _resolveRunColumns(boardId: string, candidateColumnName?: string): Promise<{
    board: Board; runColumn: BoardColumn; candidateColumn: BoardColumn;
  }> {
    const board = await this.dataSource.getRepository(Board).findOne({ where: { id: boardId } });
    if (!board) throw httpError('Board not found', 404);
    const cols = await this.dataSource.getRepository(BoardColumn).find({
      where: { board_id: boardId }, order: { position: 'ASC' },
    });
    if (cols.length === 0) throw httpError('Board has no columns', 400);
    const isTerminal = (c: BoardColumn) => (c as any).is_terminal === true || (c as any).kind === 'terminal';
    const runColumn = cols[0];
    const candidateColumn =
      (candidateColumnName ? cols.find((c) => c.name.toLowerCase() === candidateColumnName.toLowerCase()) : undefined) ||
      cols.find((c) => (c as any).kind === 'active') ||
      cols.find((c) => !isTerminal(c)) ||
      runColumn;
    return { board, runColumn, candidateColumn };
  }

  private async _runBoardId(run: Ticket): Promise<string> {
    if (!run.column_id) return '';
    const col = await this.dataSource.getRepository(BoardColumn).findOne({ where: { id: run.column_id } });
    return col?.board_id || '';
  }

  private async _candidateAssigneeIds(runId: string): Promise<string[]> {
    const children = await this.dataSource.getRepository(Ticket).find({ where: { parent_id: runId } });
    return children.filter((c) => this._isCandidate(c)).map((c) => c.assignee_id).filter(Boolean);
  }

  private async _logRunActivity(runId: string, title: string, actorName: string): Promise<void> {
    try {
      await this.activityService?.logActivity({
        entity_type: 'ticket', entity_id: runId, action: 'created',
        new_value: title, ticket_id: runId, actor_name: actorName || 'benchmark',
      });
    } catch (e) {
      this.logService?.warn('Benchmark', `logActivity failed for run ${runId}: ${String(e)}`);
    }
  }

  private _parseLabels(raw: any): string[] {
    if (Array.isArray(raw)) return raw.filter((x) => typeof x === 'string');
    if (typeof raw === 'string' && raw.trim()) {
      try { const v = JSON.parse(raw); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; }
      catch { return []; }
    }
    return [];
  }

  private _runStateFromLabels(labels: string[]): 'draft' | 'started' {
    return labels.includes(LABEL_DRAFT) ? 'draft' : 'started';
  }

  private _isCandidate(t: Ticket): boolean {
    return this._parseLabels(t.labels).includes(LABEL_CANDIDATE);
  }

  private _candcolFromLabels(labels: string[]): string {
    const l = labels.find((x) => x.startsWith(PREFIX_CANDCOL));
    return l ? l.slice(PREFIX_CANDCOL.length) : '';
  }

  private _composeRunDescription(prompt: string, rubric?: string, baseRepo?: string): string {
    const parts = [prompt || ''];
    if (rubric && rubric.trim()) parts.push('\n\n## Rubric\n' + rubric);
    if (baseRepo && baseRepo.trim()) parts.push('\n\n## Base repository\n' + baseRepo);
    return parts.join('');
  }

  /**
   * Inverse of _composeRunDescription. The compose order is prompt → Rubric →
   * Base repository, so we peel the Base section off the full text first, then
   * the Rubric section off the remainder; what's left is the prompt.
   */
  private _parseRunDescription(desc: string): { prompt: string; rubric: string; base_repo: string } {
    const rubricMarker = '\n\n## Rubric\n';
    const baseMarker = '\n\n## Base repository\n';
    let working = desc || '';
    let base_repo = '';
    let rubric = '';
    const baseIdx = working.indexOf(baseMarker);
    if (baseIdx >= 0) {
      base_repo = working.slice(baseIdx + baseMarker.length);
      working = working.slice(0, baseIdx);
    }
    const rubricIdx = working.indexOf(rubricMarker);
    if (rubricIdx >= 0) {
      rubric = working.slice(rubricIdx + rubricMarker.length);
      working = working.slice(0, rubricIdx);
    }
    return { prompt: working, rubric, base_repo };
  }

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
