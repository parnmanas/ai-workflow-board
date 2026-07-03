import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ActivityLog } from '../../entities/ActivityLog';
import { Ticket } from '../../entities/Ticket';
import { BoardColumn } from '../../entities/BoardColumn';
import { Comment } from '../../entities/Comment';
import { QaScenario, QaOnFailureTicketConfig } from '../../entities/QaScenario';
import { Deployment } from '../../entities/Deployment';
import { LogService } from '../../services/log.service';
import { activityEvents } from '../../services/activity.service';
import { isTerminalColumn } from '../mcp/shared/archive-helpers';
import { QaRunService } from './qa-run.service';
import { RERUN_LABEL_PREFIX } from './qa-failure-ticket.service';
import { deploymentIncludesCommit, findLatestDeployment, normalizeSha } from '../../common/deployment-options';
import { DEPLOYMENT_REPORTED_EVENT, DeploymentReportedSignal } from '../deployments/deployment.service';

// The marker labels QaFailureTicketService stamps on every fix ticket it files.
// A ticket must carry ALL of these to be eligible for an automatic rerun — this
// is the scope guard that stops a human-labelled ticket from firing a run.
//
// ⚠️ Coupling: these mirror QaFailureTicketService.DEFAULT_LABELS, but that
// service only applies the defaults when `on_failure_ticket.labels` is unset —
// a scenario that customises `cfg.labels` and drops 'auto' would file fix
// tickets that this guard silently REJECTS (no rerun, no error). The two
// anchors that are ALWAYS present regardless of cfg.labels are the
// `qa-scenario:<id>` marker (added unconditionally) and the `rerun_on_fix`
// opt-in gate (checked below) — those are the real scope. Treat the label
// match as belt-and-suspenders: if you customise cfg.labels, keep 'qa-failure'
// + 'auto' in the list, or relax this constant to the scenario marker alone.
const REQUIRED_LABELS = ['qa-failure', 'auto'];
const SCENARIO_LABEL_PREFIX = 'qa-scenario:';

// Optional label a merging/assignee step stamps on a fix ticket to name the exact
// merged commit — the anchor the deployment-fact gate (DoD 3) checks for inclusion
// in the target environment's live deployment. Absent → the gate falls back to
// deploy-freshness ordering (deployed_at >= the fix ticket's Done instant).
const FIX_COMMIT_LABEL_PREFIX = 'fix-commit:';

// Default convergence cap when the scenario doesn't set max_rerun_attempts.
const DEFAULT_MAX_RERUN_ATTEMPTS = 3;

/**
 * A rerun deferred by the deployment-fact gate (DoD 3): the fix ticket reached
 * Done but the target environment's live deployment does not yet include the fix.
 * Held in-memory (like the legacy delay timers) keyed by `${ticketId}:${gen}` and
 * fired the instant a matching deployment lands — or by the optional fallback cap
 * timer. NOTE: not durable across a server restart (same limitation the legacy
 * rerun_delay_seconds timer has); a restart-while-pending drops the deferred run.
 */
interface PendingRerun {
  scenarioId: string;
  generation: number;
  fixTicketId: string;
  scenarioName: string;
  workspaceId: string | null;
  environment: string;
  /** '' when no `fix-commit:` label → the gate uses deploy-freshness ordering. */
  fixCommitSha: string;
  /** The fix ticket's terminal_entered_at — the freshness-ordering baseline. */
  notBefore: Date | null;
  fallbackTimer?: ReturnType<typeof setTimeout>;
}

function safeJsonParse<T = any>(val: string | null | undefined, fallback: T): T {
  try {
    return JSON.parse(val || JSON.stringify(fallback)) as T;
  } catch {
    return fallback;
  }
}

/**
 * QaRerunOnFixService — closes the QA → fix → QA loop (ticket 467dbc7a).
 *
 * Subscribes to the same `activityEvents` 'activity' stream OnTicketDoneActionService
 * uses — deliberately a SEPARATE listener inside the QA module rather than a hook
 * inside the actions module, so neither module takes a dependency on the other.
 *
 * When a QA-failure fix ticket (filed by QaFailureTicketService, so it carries
 * `qa-failure` + `auto` + `qa-scenario:<id>`) lands on a terminal (Done) column
 * AND its scenario opted into `on_failure_ticket.rerun_on_fix`, this service
 * re-runs the SAME scenario by calling QaRunService.startQaRun directly — no
 * agent prompt parsing, fully server-side and deterministic.
 *
 * Idempotency: an atomic conditional claim on `Ticket.qa_rerun_dispatched_at` vs
 * `terminal_entered_at` (the SAME edge-claim pattern as the on-done hook, but a
 * dedicated stamp column so the two hooks don't starve each other). At most one
 * rerun per terminal ENTRY; a leave-and-return re-stamps terminal_entered_at and
 * fires again, a reorder within Done does not.
 *
 * Convergence: each rerun carries a generation (read from the Done ticket's
 * `qa-rerun:<n>` label; absent = 0). When the generation reaches
 * `max_rerun_attempts` (default 3) the loop HALTS — it posts a "human
 * intervention needed" comment instead of re-running. Otherwise it starts the
 * run at generation + 1; if that run also fails, QaFailureTicketService files a
 * new fix ticket stamped `qa-rerun:<gen+1>`, and the cycle continues until the
 * run passes (natural stop — no new ticket) or the cap is hit.
 *
 * Deployment timing: the rerun hits the RUNNING server, which auto-deploys from
 * `production.private` only AFTER main merges. An instant rerun can therefore
 * validate the pre-fix code.
 *   • Legacy fallback — `on_failure_ticket.rerun_delay_seconds` defers the rerun
 *     by a fixed N seconds (best-effort, in-process) so a deploy can land first.
 *     Re-breaks whenever the real deploy time drifts.
 *   • Deployment-fact gate (DoD 3) — when `deployment_gate` is set and the
 *     scenario has a `target_environment`, the rerun instead WAITS until that
 *     environment's live deployment actually includes the fix commit (or, absent
 *     a `fix-commit:<sha>` label, until a deploy lands at/after the fix's Done),
 *     firing the instant a matching `report_deployment` / self-report arrives
 *     (DEPLOYMENT_REPORTED_EVENT). `rerun_delay_seconds` still applies as a
 *     best-effort fallback cap. Not time-hardcoded — this is the DoD path.
 * See docs/qa-rerun-on-fix.md.
 */
@Injectable()
export class QaRerunOnFixService implements OnModuleInit, OnModuleDestroy {
  private _activityListener?: (log: ActivityLog) => void;
  // Deployment-fact gate (DoD 3): re-evaluates pending reruns when a deployment
  // lands. Separate listener on the same in-process bus (no module dependency).
  private _deploymentListener?: (signal: DeploymentReportedSignal) => void;
  // Pending delayed reruns so onModuleDestroy can cancel them (test rigs that
  // build/tear down the Nest module per spec would otherwise leak timers).
  private readonly _timers = new Set<ReturnType<typeof setTimeout>>();
  // Reruns deferred until the target environment deploys the fix (DoD 3), keyed
  // by `${fixTicketId}:${generation}` so a duplicate 'moved' can't double-register.
  private readonly _pending = new Map<string, PendingRerun>();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly qaRunService: QaRunService,
    private readonly logService: LogService,
  ) {}

  onModuleInit() {
    this._activityListener = (log: ActivityLog) => {
      this._handleActivity(log).catch((e: unknown) => {
        this.logService.error('QA', 'QaRerunOnFixService _handleActivity error', { err: e });
      });
    };
    activityEvents.on('activity', this._activityListener);

    this._deploymentListener = (signal: DeploymentReportedSignal) => {
      this._onDeploymentReported(signal).catch((e: unknown) => {
        this.logService.error('QA', 'QaRerunOnFixService _onDeploymentReported error', { err: e });
      });
    };
    activityEvents.on(DEPLOYMENT_REPORTED_EVENT, this._deploymentListener);
  }

  onModuleDestroy() {
    if (this._activityListener) {
      activityEvents.removeListener('activity', this._activityListener);
      this._activityListener = undefined;
    }
    if (this._deploymentListener) {
      activityEvents.removeListener(DEPLOYMENT_REPORTED_EVENT, this._deploymentListener);
      this._deploymentListener = undefined;
    }
    for (const t of this._timers) clearTimeout(t);
    this._timers.clear();
    for (const p of this._pending.values()) if (p.fallbackTimer) clearTimeout(p.fallbackTimer);
    this._pending.clear();
  }

  private async _handleActivity(log: ActivityLog): Promise<void> {
    // Only column moves can land a ticket on a terminal column.
    if (log.action !== 'moved' || !log.ticket_id) return;

    const ticketRepo = this.dataSource.getRepository(Ticket);
    const ticket = await ticketRepo.findOne({ where: { id: log.ticket_id } });
    if (!ticket || !ticket.column_id) return;

    const col = await this.dataSource.getRepository(BoardColumn).findOne({ where: { id: ticket.column_id } });
    if (!isTerminalColumn(col)) return;
    // Without a terminal-entry anchor the edge-claim predicate has nothing to
    // compare against — bail (matches the on-done hook's "same entry" semantics).
    if (!ticket.terminal_entered_at) return;

    // ── Scope guard (cheap, pre-claim) ──────────────────────────────────────
    // Only a QA-failure fix ticket carrying ALL marker labels is eligible.
    const labels = safeJsonParse<string[]>(ticket.labels, []);
    if (!Array.isArray(labels)) return;
    if (!REQUIRED_LABELS.every((l) => labels.includes(l))) return;
    const scenarioId = this._parseScenarioId(labels);
    if (!scenarioId) return;

    const scenario = await this.dataSource.getRepository(QaScenario).findOne({ where: { id: scenarioId } });
    // Opt-in gate: scenario must exist, still carry the policy, and have
    // rerun_on_fix enabled. (Negative case: opt-out → never fires.)
    const cfg = scenario?.on_failure_ticket;
    if (!scenario || !cfg?.enabled || !cfg.rerun_on_fix) return;

    const maxAttempts = this._resolveMaxAttempts(cfg.max_rerun_attempts);
    if (maxAttempts <= 0) return; // reruns explicitly disabled.

    const currentGen = this._parseGeneration(labels);

    // ── Atomic once-per-terminal-entry claim ────────────────────────────────
    // Claim BEFORE acting in BOTH branches (rerun and halt) so a duplicate
    // 'moved' for the same entry can neither double-run nor double-comment.
    const claimAt = new Date();
    const claim = await ticketRepo
      .createQueryBuilder()
      .update(Ticket)
      .set({ qa_rerun_dispatched_at: claimAt })
      .where('id = :id', { id: ticket.id })
      .andWhere('terminal_entered_at IS NOT NULL')
      .andWhere('(qa_rerun_dispatched_at IS NULL OR qa_rerun_dispatched_at < terminal_entered_at)')
      .execute();
    const claimed = claim.affected === undefined || claim.affected === null || claim.affected > 0;
    if (!claimed) {
      this.logService.info('QA', 'rerun-on-fix skipped (already dispatched this terminal entry)', {
        ticket_id: ticket.id,
      });
      return;
    }

    // ── Convergence cap ─────────────────────────────────────────────────────
    if (currentGen >= maxAttempts) {
      await this._postHaltComment(ticket.id, scenario.name, currentGen, maxAttempts);
      this.logService.warn('QA', 'rerun-on-fix loop hit max attempts — halting', {
        ticket_id: ticket.id, scenario_id: scenarioId, generation: currentGen, max: maxAttempts,
      });
      return;
    }

    // ── Re-run the scenario (server-side, deterministic) ────────────────────
    const nextGen = currentGen + 1;

    // Deployment-fact gate (DoD 3): when the scenario is env-bound and opted in,
    // don't fire on the Done edge — defer until that environment actually deploys
    // the fix. Falls back to the legacy time path when the gate is off / no env.
    const env = (scenario.target_environment || '').trim();
    if (cfg.deployment_gate === true && env) {
      await this._gateOnDeployment(scenario, ticket, cfg, nextGen, env);
      return;
    }

    // Legacy path: fire immediately, or after rerun_delay_seconds (best-effort).
    const delayMs = this._resolveDelayMs(cfg.rerun_delay_seconds);
    this.logService.info('QA', 'rerun-on-fix firing', {
      ticket_id: ticket.id, scenario_id: scenarioId, next_generation: nextGen, delay_ms: delayMs,
    });
    if (delayMs > 0) {
      const timer = setTimeout(() => {
        this._timers.delete(timer);
        this._startRerun(scenarioId, nextGen, ticket.id).catch((e) => {
          this.logService.error('QA', 'rerun-on-fix delayed start failed', { err: String(e), ticket_id: ticket.id });
        });
      }, delayMs);
      // Don't keep the event loop alive purely for a pending rerun timer.
      if (typeof (timer as any).unref === 'function') (timer as any).unref();
      this._timers.add(timer);
    } else {
      await this._startRerun(scenarioId, nextGen, ticket.id);
    }
  }

  // ── Deployment-fact gate (DoD 3) ─────────────────────────────────────────────

  /**
   * Gate the rerun on the target environment's live deployment INCLUDING the fix.
   * If it already does, fire now. Otherwise register a pending rerun that fires
   * when a matching DEPLOYMENT_REPORTED_EVENT lands — with rerun_delay_seconds, if
   * set, as a best-effort fallback cap so the rerun is never stranded forever.
   */
  private async _gateOnDeployment(
    scenario: QaScenario,
    ticket: Ticket,
    cfg: QaOnFailureTicketConfig,
    generation: number,
    environment: string,
  ): Promise<void> {
    const fixSha = this._resolveFixCommit(ticket);
    const dep = await findLatestDeployment(this.dataSource.getRepository(Deployment), scenario.workspace_id, environment);
    if (this._deploymentSatisfies(dep, fixSha, ticket.terminal_entered_at)) {
      this.logService.info('QA', 'rerun-on-fix deployment gate already satisfied — firing now', {
        ticket_id: ticket.id, scenario_id: scenario.id, environment,
        deployed_commit: dep?.deployed_commit_sha?.slice(0, 12), fix_commit: fixSha || '(freshness)',
      });
      await this._startRerun(scenario.id, generation, ticket.id);
      return;
    }

    const key = `${ticket.id}:${generation}`;
    // A duplicate 'moved' for the same entry is already blocked by the atomic
    // qa_rerun_dispatched_at claim upstream, but guard the map too.
    if (this._pending.has(key)) return;
    const pending: PendingRerun = {
      scenarioId: scenario.id,
      generation,
      fixTicketId: ticket.id,
      scenarioName: scenario.name,
      workspaceId: scenario.workspace_id,
      environment,
      fixCommitSha: fixSha,
      notBefore: ticket.terminal_entered_at ?? null,
    };
    const capMs = this._resolveDelayMs(cfg.rerun_delay_seconds);
    if (capMs > 0) {
      const timer = setTimeout(() => {
        this.logService.warn('QA', 'rerun-on-fix deployment gate fallback cap reached — firing without a confirmed deploy', {
          ticket_id: ticket.id, scenario_id: scenario.id, environment, cap_ms: capMs,
        });
        this._firePending(key).catch((e) => {
          this.logService.error('QA', 'rerun-on-fix fallback fire failed', { err: String(e), ticket_id: ticket.id });
        });
      }, capMs);
      if (typeof (timer as any).unref === 'function') (timer as any).unref();
      pending.fallbackTimer = timer;
    }
    this._pending.set(key, pending);
    this.logService.info('QA', 'rerun-on-fix waiting for deployment', {
      ticket_id: ticket.id, scenario_id: scenario.id, environment,
      fix_commit: fixSha || '(freshness-ordering: deployed_at >= fix Done)',
      fallback_cap_ms: capMs || 0,
    });
  }

  /**
   * A deployment landed — re-evaluate every pending rerun bound to that
   * environment and fire the ones the new deployment now satisfies.
   */
  private async _onDeploymentReported(signal: DeploymentReportedSignal): Promise<void> {
    if (this._pending.size === 0) return;
    const env = (signal.environment || '').trim();
    if (!env) return;
    // Snapshot entries — _firePending mutates the map mid-loop.
    for (const [key, p] of [...this._pending.entries()]) {
      if (p.environment !== env) continue;
      const dep = await findLatestDeployment(this.dataSource.getRepository(Deployment), p.workspaceId, env);
      if (!this._deploymentSatisfies(dep, p.fixCommitSha, p.notBefore)) continue;
      this.logService.info('QA', 'rerun-on-fix deployment gate satisfied — firing', {
        fix_ticket_id: p.fixTicketId, scenario_id: p.scenarioId, environment: env,
        deployed_commit: signal.deployed_commit_sha?.slice(0, 12),
      });
      await this._firePending(key);
    }
  }

  /**
   * Fire a pending rerun exactly once: delete-then-run so the fallback-cap timer
   * and a deployment event can never start the same run twice.
   */
  private async _firePending(key: string): Promise<void> {
    const p = this._pending.get(key);
    if (!p) return; // already fired (race between cap timer and deploy event).
    this._pending.delete(key);
    if (p.fallbackTimer) { clearTimeout(p.fallbackTimer); p.fallbackTimer = undefined; }
    await this._startRerun(p.scenarioId, p.generation, p.fixTicketId);
  }

  /** `fix-commit:<sha>` label → normalized sha, or '' (→ freshness-ordering gate). */
  private _resolveFixCommit(ticket: Ticket): string {
    const labels = safeJsonParse<string[]>(ticket.labels, []);
    if (!Array.isArray(labels)) return '';
    const marker = labels.find((l) => typeof l === 'string' && l.startsWith(FIX_COMMIT_LABEL_PREFIX));
    if (!marker) return '';
    return normalizeSha(marker.slice(FIX_COMMIT_LABEL_PREFIX.length));
  }

  /**
   * Does `dep` prove the fix is live? With a known fix commit → the deployment
   * must INCLUDE it (the deployed commit itself or a known ancestor). Without one
   * (no `fix-commit:` label) → deploy-freshness ordering: a deployment that went
   * live at/after the fix ticket's Done instant is treated as carrying it.
   */
  private _deploymentSatisfies(dep: Deployment | null, fixSha: string, fixDoneAt: Date | null): boolean {
    if (!dep) return false;
    if (fixSha) return deploymentIncludesCommit(dep, fixSha);
    if (!fixDoneAt || !dep.deployed_at) return false;
    return new Date(dep.deployed_at).getTime() >= new Date(fixDoneAt).getTime();
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async _startRerun(scenarioId: string, generation: number, fixTicketId: string): Promise<void> {
    try {
      const result = await this.qaRunService.startQaRun({
        scenarioId,
        triggeredByType: 'system',
        triggeredById: 'qa-rerun-on-fix',
        rerunGeneration: generation,
      });
      this.logService.info('QA', 'rerun-on-fix started run', {
        scenario_id: scenarioId, run_id: result.run.id, generation, fix_ticket_id: fixTicketId,
      });
    } catch (e: any) {
      // A disabled scenario / missing agent throws from startQaRun — log, don't
      // crash the event listener.
      this.logService.warn('QA', `rerun-on-fix startQaRun failed for scenario ${scenarioId}: ${e?.message || e}`);
    }
  }

  /** First `qa-scenario:<uuid>` label → the scenario id, or null. */
  private _parseScenarioId(labels: string[]): string | null {
    const marker = labels.find((l) => typeof l === 'string' && l.startsWith(SCENARIO_LABEL_PREFIX));
    if (!marker) return null;
    const id = marker.slice(SCENARIO_LABEL_PREFIX.length).trim();
    return id || null;
  }

  /** Highest `qa-rerun:<n>` label value (absent = generation 0). */
  private _parseGeneration(labels: string[]): number {
    let gen = 0;
    for (const l of labels) {
      if (typeof l !== 'string' || !l.startsWith(RERUN_LABEL_PREFIX)) continue;
      const n = parseInt(l.slice(RERUN_LABEL_PREFIX.length), 10);
      if (Number.isFinite(n) && n > gen) gen = n;
    }
    return gen;
  }

  private _resolveMaxAttempts(raw: number | undefined): number {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_MAX_RERUN_ATTEMPTS;
    return Math.floor(raw);
  }

  private _resolveDelayMs(rawSeconds: number | undefined): number {
    if (typeof rawSeconds !== 'number' || !Number.isFinite(rawSeconds) || rawSeconds <= 0) return 0;
    return Math.floor(rawSeconds * 1000);
  }

  private async _postHaltComment(ticketId: string, scenarioName: string, generation: number, max: number): Promise<void> {
    const body = [
      `🛑 **QA 자동 재실행 루프 한계 도달 — 사람 개입 필요**`,
      ``,
      `시나리오 \`${scenarioName}\` 가 자동 수정 ↔ 재실행을 ${generation}회 반복했지만 여전히 통과하지 못했습니다 ` +
        `(max_rerun_attempts = ${max}).`,
      ``,
      `자동 재실행을 중단합니다. 근본 원인을 사람이 직접 확인해 주세요:`,
      `- 수정이 실제로 배포됐는지 (server 는 main→production.private auto-deploy — 배포 지연이면 옛 코드를 검증했을 수 있음)`,
      `- 시나리오 스텝/기대값 자체가 틀렸는지 (테스트 결함 vs 제품 결함)`,
      ``,
      `_이 티켓을 다시 Done 으로 옮겨도 더는 자동 재실행되지 않습니다 (세대 카운터가 한계에 도달)._`,
    ].join('\n');
    const commentRepo = this.dataSource.getRepository(Comment);
    await commentRepo.save(commentRepo.create({
      ticket_id: ticketId,
      author_type: 'system',
      author_id: '',
      author: 'QA',
      content: body,
      type: 'note',
    }));
  }
}
