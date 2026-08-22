/**
 * CiHealthMonitorService — main CI red-streak watchdog (ticket cc1c494e).
 *
 * Background: this board runs `use_pr=false` (direct push/merge), so a
 * broken main-branch CI run never blocks anything and never surfaces in a PR
 * check — it can (and did) stay red for weeks with nobody noticing. This
 * service periodically polls each board's configured GitHub repo for its CI
 * workflow(s), and once a red streak trips a threshold, posts an operator
 * chat alert AND (default on) auto-creates a Backlog ticket so the failure
 * enters the normal agent dispatch loop instead of depending on a human
 * happening to look.
 *
 * Sibling of `StuckTicketDetectorService` — same sweep/dedup/durable-delivery
 * skeleton (setInterval+unref, a dedup row per monitored target, `delivered_at`-
 * gated re-alert cooldown so a failed delivery retries every sweep instead of
 * going silent for a full cooldown window) — kept as a SEPARATE service and
 * entity (`CiRedAlert`) rather than a fourth `StuckTicketAlert.cause`, because
 * `StuckTicketAlert`'s PK IS the ticket_id it's alerting about, and a CI-red
 * episode has no ticket to key off until (and unless) this service creates one.
 *
 * Monitor target resolution (never guesses a repo): each Board's merged
 * `environment_config.repositories[0]` (workspace ⊕ board override, same
 * precedence `run-workspace-resolver.ts`'s `resolveRunRepo` uses) resolved to
 * a concrete GitHub owner/repo/branch. A board with no configured environment
 * repo, or one that isn't a github.com url, is silently skipped — never
 * widened to "guess" a repo from somewhere else.
 *
 * Trigger condition (`evaluateRedStreak`, kept pure/standalone for unit
 * testing without booting Nest): per (repo, branch, workflow), walk the most
 * recent completed runs newest-first. `cancelled`/`skipped` conclusions carry
 * no signal and are dropped before evaluation (neither extend nor break a
 * streak). Trips when the consecutive-red streak reaches `CI_MONITOR_MIN_RUNS`
 * OR the oldest run in the current streak is older than `CI_MONITOR_MIN_AGE_MS`
 * — the "OR" catches a repo with infrequent pushes where only 1-2 red runs
 * exist but a long time has passed. Recovers the instant the newest completed
 * run is green, regardless of how long the preceding streak was.
 * `event === 'schedule'`인 run도 동일하게 신호에서 제외된다 — cron 트리거 run은 대부분의
 * 잡이 skip돼도 run-level conclusion은 success로 찍히기 때문이다(ticket 654465c8).
 *
 * Ticket idempotency: the auto-created ticket carries
 * `operational_dedupe_key = "ci_red:{board_id}:{repo}:{branch}:{workflow_id}"`
 * under Ticket's pre-existing `uq_tickets_operational_dedupe_open` unique
 * index — INSERT-first, unique-violation-caught, winner-reused (never a
 * pre-SELECT check), mirroring `OutreachIngestService._createTicket` /
 * `_resolveDedupeCollision` exactly. `CiRedAlert.created_ticket_id` additionally
 * ensures at most one creation ATTEMPT per red episode even before any DB
 * race is in play.
 */
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull } from 'typeorm';
import { Board } from '../../entities/Board';
import { BoardColumn } from '../../entities/BoardColumn';
import { ChatRoom } from '../../entities/ChatRoom';
import { CiRedAlert } from '../../entities/CiRedAlert';
import { Comment } from '../../entities/Comment';
import { Resource } from '../../entities/Resource';
import { Ticket } from '../../entities/Ticket';
import { Workspace } from '../../entities/Workspace';
import { mergeEnvironmentConfig } from '../../common/environment-config';
import { parseDefaultRoleAssignments } from '../../common/default-role-assignments-config';
import { LogService } from '../../services/log.service';
import { ActivityService } from '../../services/activity.service';
import { GitHubConnectorService, GitHubRateLimitError, GitHubWorkflow, GitHubWorkflowRun, parseGitHubUrl } from '../../services/github-connector.service';
import { RoomMessagingService } from '../chat-rooms/room-messaging.service';
import { TicketRoleAssignmentService } from '../workspace-roles/ticket-role-assignment.service';
import { maxTicketPosition } from '../mcp/shared/ticket-helpers';
import { isTerminalColumn } from '../mcp/shared/archive-helpers';

const DEFAULTS = {
  ENABLED: true,
  SWEEP_MS: 30 * 60_000,          // 30 min
  MIN_RUNS: 3,                    // consecutive red completed runs
  MIN_AGE_MS: 6 * 60 * 60_000,    // 6 h since the oldest run in the streak
  REALERT_MS: 24 * 60 * 60_000,   // 24 h cooldown between re-alerts
  CREATE_TICKET: true,
} as const;

export interface CiHealthMonitorConfig {
  enabled: boolean;
  sweepMs: number;
  minRuns: number;
  minAgeMs: number;
  realertMs: number;
  createTicket: boolean;
}

function readConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CiHealthMonitorConfig {
  const parseIntEnv = (raw: string | undefined, fallback: number): number => {
    if (raw == null || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  // 'false' / '0' / 'no' / 'off' all disable; anything else (including unset) → default.
  const parseBool = (raw: string | undefined, fallback: boolean): boolean => {
    if (raw == null) return fallback;
    const v = raw.trim().toLowerCase();
    if (v === '') return fallback;
    if (['false', '0', 'no', 'off'].includes(v)) return false;
    return true;
  };
  return {
    enabled: parseBool(env.CI_MONITOR_ENABLED, DEFAULTS.ENABLED),
    sweepMs: parseIntEnv(env.CI_MONITOR_SWEEP_MS, DEFAULTS.SWEEP_MS),
    minRuns: parseIntEnv(env.CI_MONITOR_MIN_RUNS, DEFAULTS.MIN_RUNS),
    minAgeMs: parseIntEnv(env.CI_MONITOR_MIN_AGE_MS, DEFAULTS.MIN_AGE_MS),
    realertMs: parseIntEnv(env.CI_MONITOR_REALERT_MS, DEFAULTS.REALERT_MS),
    createTicket: parseBool(env.CI_MONITOR_CREATE_TICKET, DEFAULTS.CREATE_TICKET),
  };
}

// Exposed for unit tests so a spec can construct configs without touching
// the host environment (mirrors stuck-ticket-detector.service.ts's __test__).
export const __test__ = { readConfigFromEnv, DEFAULTS };

// conclusions that carry no health signal — dropped before evaluation so they
// neither extend nor break a streak (ticket body: "cancelled|skipped는 신호
// 아님으로 제외").
const RED_CONCLUSIONS: ReadonlySet<string> = new Set(['failure', 'timed_out', 'startup_failure']);
const SIGNAL_CONCLUSIONS: ReadonlySet<string> = new Set(['success', ...RED_CONCLUSIONS]);

export interface RedStreakResult {
  /** Trip condition met on THIS evaluation (streak or age threshold crossed). */
  isRed: boolean;
  /** Newest completed run succeeded — the recovery signal. */
  isGreen: boolean;
  /** Consecutive red runs counting back from the newest signal run. */
  streak: number;
  /** Oldest run within the current streak (undefined streak → null). */
  firstFailedRun: GitHubWorkflowRun | null;
  /** Newest signal run overall (null when there is no completed-run signal yet). */
  lastRun: GitHubWorkflowRun | null;
}

/**
 * Pure red-streak decision — no DB, no HTTP — so the threshold logic is
 * deterministically unit-testable against fixture run lists. `runs` is
 * expected newest-first (GitHub's default order / `listWorkflowRuns`'s
 * contract), already narrowed to one workflow + branch.
 */
export function evaluateRedStreak(
  runs: GitHubWorkflowRun[],
  now: Date,
  config: { minConsecutiveRuns: number; minAgeMs: number },
): RedStreakResult {
  // schedule(cron) 트리거 run은 워크플로 대부분의 잡이 `if: ... != 'schedule'`로 skip되지만
  // run-level conclusion은 그대로 success로 찍힌다 — signal에서 통째로 제외해 잡 5/6 skip인
  // run이 진짜 복구로도, 스트릭 브레이커로도 오판되지 않게 한다(ticket 654465c8).
  const signal = (runs || []).filter((r) => SIGNAL_CONCLUSIONS.has(r.conclusion || '') && r.event !== 'schedule');
  if (signal.length === 0) {
    return { isRed: false, isGreen: false, streak: 0, firstFailedRun: null, lastRun: null };
  }
  const lastRun = signal[0];
  if (lastRun.conclusion === 'success') {
    return { isRed: false, isGreen: true, streak: 0, firstFailedRun: null, lastRun };
  }
  let streak = 0;
  let firstFailedRun = lastRun;
  for (const run of signal) {
    if (!RED_CONCLUSIONS.has(run.conclusion || '')) break;
    streak += 1;
    firstFailedRun = run;
  }
  const firstFailedAtMs = new Date(firstFailedRun.updated_at).getTime();
  const ageMs = Number.isFinite(firstFailedAtMs) ? now.getTime() - firstFailedAtMs : 0;
  const isRed = streak >= config.minConsecutiveRuns || (streak >= 1 && ageMs >= config.minAgeMs);
  return { isRed, isGreen: false, streak, firstFailedRun, lastRun };
}

function isUniqueConstraintError(error: unknown): boolean {
  const value = error as {
    code?: string;
    errno?: number;
    message?: string;
    driverError?: { code?: string; errno?: number; message?: string };
  } | null;
  const driverError = value?.driverError;
  const code = driverError?.code ?? value?.code;
  const errno = driverError?.errno ?? value?.errno;
  const message = driverError?.message ?? value?.message ?? '';
  return code === '23505'
    || code === 'SQLITE_CONSTRAINT_UNIQUE'
    || code === 'ER_DUP_ENTRY'
    || errno === 1062
    || /unique constraint failed/i.test(message);
}

interface MonitorTarget {
  owner: string;
  repo: string;
  repoFullName: string;
  branch: string;
  credentialId: string | null;
}

interface CiSweepStats {
  boards_scanned: number;
  targets_checked: number;
  alerts_created: number;
  alerts_updated: number;
  tickets_created: number;
  delivery_failures: number;
  recovered: number;
  skipped_disabled: boolean;
  /** GitHub reads that failed non-degradably (401/403/429/5xx/network) — see
   *  isGitHubDegradableError. Each one is also logged under 'CI' with
   *  board/repo/workflow context; a nonzero count here means the sweep did
   *  NOT get a full picture this pass, even though it didn't throw. */
  fetch_failures: number;
}

@Injectable()
export class CiHealthMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly config: CiHealthMonitorConfig;
  private tickHandle: NodeJS.Timeout | null = null;
  private readonly github: GitHubConnectorService;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logService: LogService,
    private readonly activityService: ActivityService,
    private readonly messaging: RoomMessagingService,
    private readonly roleAssignmentService: TicketRoleAssignmentService,
  ) {
    this.config = readConfigFromEnv();
    // GitHubConnectorService lives in McpServicesModule, which AgentsModule
    // does not import (avoids a cross-module cycle). Constructed directly —
    // it only needs the DataSource — mirroring the existing
    // trigger-loop.service.ts:3157 precedent for the same constraint.
    this.github = new GitHubConnectorService(this.dataSource);
  }

  onModuleInit(): void {
    if (!this.config.enabled) {
      this.logService.info('CI', 'CiHealthMonitorService disabled via CI_MONITOR_ENABLED=false', {
        config: this.config,
      });
      return;
    }
    this.tickHandle = setInterval(() => {
      this.sweep().catch((e: unknown) => {
        this.logService.error('CI', 'sweep failed', { err: String(e) });
      });
    }, this.config.sweepMs);
    // Same as StuckTicketDetectorService — the tick loop must never keep the
    // process alive on its own; Nest's lifecycle owns shutdown.
    if (typeof this.tickHandle?.unref === 'function') this.tickHandle.unref();
    this.logService.info('CI', 'CI health sweep loop initialized', { config: this.config });
  }

  onModuleDestroy(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  /** Test helper — read the loaded config so a spec can assert env parsing. */
  getConfig(): CiHealthMonitorConfig {
    return { ...this.config };
  }

  /**
   * Public test hook — equivalent to one tick of the internal loop. Returns
   * light stats so a spec can assert "one alert row created, one ticket
   * created" without observing internal state.
   */
  async sweep(now: Date = new Date()): Promise<CiSweepStats> {
    const stats: CiSweepStats = {
      boards_scanned: 0, targets_checked: 0, alerts_created: 0, alerts_updated: 0,
      tickets_created: 0, delivery_failures: 0, recovered: 0,
      skipped_disabled: !this.config.enabled,
      fetch_failures: 0,
    };
    if (!this.config.enabled) return stats;

    const boards = await this.dataSource.getRepository(Board).find();
    // Cache API responses per (owner/repo/credential) and
    // (owner/repo/credential/workflow/branch) for the DURATION of this sweep
    // only — several boards can point at the same repo, and each still needs
    // its own per-board alert/ticket evaluation, but the underlying GitHub
    // calls should fire once PER CREDENTIAL. credentialId is part of the key
    // (ticket cc1c494e review) — two boards on the same repo with different
    // credentials must never share a cached success or a cached rejection. A
    // rejected promise is cached too — a second board hitting the same
    // broken repo/workflow/credential this sweep reuses the failure instead
    // of hammering an endpoint already known to be down this pass.
    const workflowsCache = new Map<string, Promise<GitHubWorkflow[]>>();
    const runsCache = new Map<string, Promise<GitHubWorkflowRun[]>>();

    for (const board of boards) {
      stats.boards_scanned += 1;
      const target = await this._resolveMonitorTarget(board);
      if (!target) continue;
      // No token resolves for THIS target — neither its own Resource
      // credential nor the env fallback. Checked per-target (never globally
      // up front): env GITHUB_TOKEN being unset must not blind the sweep to
      // every OTHER board whose Resource carries its own working credential
      // (ticket cc1c494e review — this was the bug: a global env-only check
      // skipped the entire sweep even when a board credential was valid).
      if (!(await this.github.isEnabled(target.credentialId))) continue;

      // credentialId is part of the cache key (with an explicit sentinel for
      // the env-token fallback) — two boards can point at the SAME repo with
      // DIFFERENT credentials, and each credential's success/failure must
      // stay independent. Keying by owner/repo alone made the first board's
      // cached promise (success OR rejection) get reused for a second board's
      // different credential (ticket cc1c494e review — a private repo watched
      // by an invalid credential on one board would poison a valid credential
      // on another board of the same repo).
      const credKey = target.credentialId ?? '__env__';
      const wfKey = `${target.owner}/${target.repo}/${credKey}`;
      if (!workflowsCache.has(wfKey)) {
        workflowsCache.set(wfKey, this.github.listWorkflows(target.owner, target.repo, target.credentialId));
      }
      let workflows: GitHubWorkflow[];
      try {
        workflows = await workflowsCache.get(wfKey)!;
      } catch (e) {
        stats.fetch_failures += 1;
        this.logService.warn('CI', 'GitHub workflow list fetch failed — skipping this board this sweep', {
          board_id: board.id, repo: target.repoFullName, branch: target.branch, ...this._describeFetchError(e),
        });
        continue;
      }

      for (const workflow of workflows) {
        stats.targets_checked += 1;
        const runsKey = `${wfKey}/${workflow.id}/${target.branch}`;
        if (!runsCache.has(runsKey)) {
          runsCache.set(
            runsKey,
            this.github.listWorkflowRuns(target.owner, target.repo, workflow.id, target.branch, target.credentialId),
          );
        }
        let runs: GitHubWorkflowRun[];
        try {
          runs = await runsCache.get(runsKey)!;
        } catch (e) {
          stats.fetch_failures += 1;
          this.logService.warn('CI', 'GitHub workflow runs fetch failed — skipping this workflow this sweep', {
            board_id: board.id, repo: target.repoFullName, branch: target.branch,
            workflow_id: workflow.id, workflow_name: workflow.name, ...this._describeFetchError(e),
          });
          continue;
        }
        const evalResult = evaluateRedStreak(runs, now, {
          minConsecutiveRuns: this.config.minRuns,
          minAgeMs: this.config.minAgeMs,
        });
        await this._applyEvaluation(board, target, workflow, evalResult, now, stats);
      }
    }
    return stats;
  }

  /** Loggable fields for a caught GitHub fetch error — surfaces the
   *  Retry-After hint on a rate-limit error since that's actionable context
   *  a plain message string would bury. */
  private _describeFetchError(e: unknown): { err: string; retry_after_ms?: number } {
    const out: { err: string; retry_after_ms?: number } = { err: e instanceof Error ? e.message : String(e) };
    if (e instanceof GitHubRateLimitError) out.retry_after_ms = e.retryAfterMs;
    return out;
  }

  /**
   * Resolve a board's monitored GitHub target from its merged environment
   * config, mirroring `run-workspace-resolver.ts`'s `resolveRunRepo` repo-Resource
   * path exactly (same precedence: direct url wins, else resource_id lookup;
   * branch falls back to the Resource's default_branch). Returns null — never
   * a guess — when nothing is configured or the resolved url isn't github.com.
   */
  private async _resolveMonitorTarget(board: Board): Promise<MonitorTarget | null> {
    if (!board.workspace_id) return null;
    const ws = await this.dataSource.getRepository(Workspace).findOne({ where: { id: board.workspace_id } });
    const merged = mergeEnvironmentConfig(ws?.environment_config, board.environment_config);
    const first = merged?.repositories?.[0];
    if (!first) return null;

    let url = (first.url || '').trim();
    let branch = (first.branch || '').trim();
    let credentialId: string | null = null;
    if (first.resource_id) {
      const resource = await this.dataSource.getRepository(Resource).findOne({ where: { id: first.resource_id.trim() } });
      if (resource && resource.workspace_id !== null && resource.workspace_id !== board.workspace_id) return null;
      if (!url) url = (resource?.url || '').trim();
      if (!branch) branch = (resource?.default_branch || '').trim();
      credentialId = resource?.credential_id || null;
    }
    if (!url || !branch) return null;

    const parsed = parseGitHubUrl(url);
    if (!parsed) return null; // not a github.com url — silently skip, never guess elsewhere
    return { owner: parsed.owner, repo: parsed.repo, repoFullName: `${parsed.owner}/${parsed.repo}`, branch, credentialId };
  }

  private async _applyEvaluation(
    board: Board,
    target: MonitorTarget,
    workflow: GitHubWorkflow,
    evalResult: RedStreakResult,
    now: Date,
    stats: CiSweepStats,
  ): Promise<void> {
    const alertRepo = this.dataSource.getRepository(CiRedAlert);
    const existing = await alertRepo.findOne({
      where: { board_id: board.id, repo_full_name: target.repoFullName, branch: target.branch, workflow_id: workflow.id },
    });

    if (evalResult.isGreen) {
      if (existing) await this._handleRecovery(board, target, workflow, existing, stats);
      return;
    }
    if (!evalResult.isRed) return; // no signal yet, or below threshold — wait for more data

    let row = existing;
    const isNewRow = !row;
    if (!row) {
      row = alertRepo.create({
        board_id: board.id,
        workspace_id: board.workspace_id || '',
        repo_full_name: target.repoFullName,
        branch: target.branch,
        workflow_id: workflow.id,
        delivered_at: null,
        delivery_attempts: 0,
        created_ticket_id: null,
      });
    }
    row.workflow_name = workflow.name;
    row.streak = evalResult.streak;
    row.first_failed_run_id = evalResult.firstFailedRun?.id || '';
    row.last_run_id = evalResult.lastRun?.id || '';
    await alertRepo.save(row);
    if (isNewRow) stats.alerts_created += 1; else stats.alerts_updated += 1;

    if (this.config.createTicket && !row.created_ticket_id) {
      try {
        const ticketId = await this._createOrReuseTicket(board, target, workflow, evalResult);
        if (ticketId) {
          row.created_ticket_id = ticketId;
          await alertRepo.save(row);
          stats.tickets_created += 1;
        }
      } catch (e) {
        this.logService.warn('CI', 'CI-red ticket auto-creation failed — will retry next sweep', {
          err: String(e), board_id: board.id, repo: target.repoFullName,
        });
      }
    }

    // Re-alert cooldown keys off delivered_at (last SUCCESSFUL post), never
    // off a plain last-attempt timestamp — a first delivery that fails is
    // retried every sweep instead of silenced for a full cooldown window
    // (same durable-delivery contract as StuckTicketAlert, ticket e7c87517
    // blocker #3).
    if (row.delivered_at && now.getTime() - new Date(row.delivered_at).getTime() < this.config.realertMs) {
      return;
    }
    row.delivery_attempts = (row.delivery_attempts || 0) + 1;
    await alertRepo.save(row);
    const delivered = await this._postRedAlert(board, target, workflow, row, evalResult, now);
    if (delivered) {
      row.delivered_at = now;
      await alertRepo.save(row);
    } else {
      stats.delivery_failures += 1;
      this.logService.warn('CI', 'CI-red alert delivery failed — will retry next sweep', {
        board_id: board.id, repo: target.repoFullName, delivery_attempts: row.delivery_attempts,
      });
    }
  }

  private async _postRedAlert(
    board: Board,
    target: MonitorTarget,
    workflow: GitHubWorkflow,
    row: CiRedAlert,
    evalResult: RedStreakResult,
    now: Date,
  ): Promise<boolean> {
    const roomId = await this._resolveAlertRoomId(board.workspace_id || '');
    if (!roomId) {
      this.logService.warn('CI', 'no chat room available for CI-red alert — will retry next sweep', {
        board_id: board.id, repo: target.repoFullName,
      });
      return false;
    }
    let failedJobs: string[] = [];
    if (evalResult.lastRun) {
      try {
        failedJobs = await this.github.listRunFailedJobs(target.owner, target.repo, evalResult.lastRun.id, target.credentialId);
      } catch (e) {
        // Decorative only (job names in the alert body) — post the alert
        // without them rather than losing the whole alert over this, but the
        // failure must still be logged, not silently dropped.
        this.logService.warn('CI', 'GitHub failed-jobs fetch failed — posting alert without job detail', {
          board_id: board.id, repo: target.repoFullName, run_id: evalResult.lastRun.id, ...this._describeFetchError(e),
        });
      }
    }
    const ageH = evalResult.firstFailedRun
      ? Math.max(0, (now.getTime() - new Date(evalResult.firstFailedRun.updated_at).getTime()) / 3_600_000)
      : 0;
    const lines = [
      `🔴 **CI red** — \`${target.repoFullName}@${target.branch}\` · ${workflow.name}`,
      `연속 ${row.streak}회 실패 · 최초 실패 후 ${ageH.toFixed(1)}시간 경과`,
      failedJobs.length > 0 ? `실패한 잡: ${failedJobs.join(', ')}` : '',
      evalResult.lastRun?.html_url ? `[최신 run 보기](${evalResult.lastRun.html_url})` : '',
      row.created_ticket_id ? `추적 티켓: [열기](/ws/${board.workspace_id}/ticket/${row.created_ticket_id})` : '',
    ].filter(Boolean);
    try {
      await this.messaging.sendSystemMessage(roomId, board.workspace_id || '', lines.join('\n\n'));
      this.logService.info('CI', 'CI-red alert posted', {
        board_id: board.id, repo: target.repoFullName, streak: row.streak,
      });
      return true;
    } catch (e) {
      this.logService.warn('CI', 'CI-red alert post failed', {
        err: String(e), board_id: board.id, repo: target.repoFullName,
      });
      return false;
    }
  }

  /**
   * Recovery: newest completed run is green. Posts a one-shot "CI 복구" chat
   * message, appends a recovery comment on the tracked ticket (if one was
   * created) WITHOUT closing it — a green run may just mean someone else's
   * push happened to fix it, or masked the issue; closing the loop is left to
   * whoever is holding the ticket — then deletes the row (self-pruning, same
   * as StuckTicketAlert's unstuck path).
   */
  private async _handleRecovery(
    board: Board,
    target: MonitorTarget,
    workflow: GitHubWorkflow,
    row: CiRedAlert,
    stats: CiSweepStats,
  ): Promise<void> {
    const roomId = await this._resolveAlertRoomId(board.workspace_id || '');
    if (roomId) {
      const lines = [
        `✅ **CI 복구** — \`${target.repoFullName}@${target.branch}\` · ${workflow.name}`,
        `연속 ${row.streak}회 실패 후 최신 run이 성공으로 복구됐습니다.`,
      ];
      try {
        await this.messaging.sendSystemMessage(roomId, board.workspace_id || '', lines.join('\n\n'));
        this.logService.info('CI', 'CI recovery posted', { board_id: board.id, repo: target.repoFullName });
      } catch (e) {
        this.logService.warn('CI', 'CI recovery post failed (row still cleared)', {
          err: String(e), board_id: board.id, repo: target.repoFullName,
        });
      }
    }
    if (row.created_ticket_id) {
      try {
        const commentRepo = this.dataSource.getRepository(Comment);
        await commentRepo.save(commentRepo.create({
          ticket_id: row.created_ticket_id,
          author_type: 'system',
          author_id: '',
          author: 'CiHealthMonitor',
          content: `✅ CI가 복구됐습니다 — \`${target.repoFullName}@${target.branch}\`(${workflow.name}) 최신 run이 성공했습니다. 자동으로 완료 처리하지 않으니 확인 후 필요 시 직접 마무리해주세요.`,
          type: 'note',
        }));
      } catch (e) {
        this.logService.warn('CI', 'CI recovery ticket comment failed', {
          err: String(e), ticket_id: row.created_ticket_id,
        });
      }
    }
    await this.dataSource.getRepository(CiRedAlert).delete({ id: row.id });
    stats.recovered += 1;
  }

  /**
   * Resolve the chat room to publish into for a workspace. Order:
   *   1. Workspace.alerts_chat_room_id, if set and the room exists.
   *   2. Oldest chat room in the workspace by `created_at ASC`.
   * Mirrors StuckTicketDetectorService._resolveAlertRoomId exactly (kept as
   * a local copy — that method is private on an unrelated service).
   */
  private async _resolveAlertRoomId(workspaceId: string): Promise<string | null> {
    if (!workspaceId) return null;
    const ws = await this.dataSource.getRepository(Workspace).findOne({ where: { id: workspaceId } });
    const roomRepo = this.dataSource.getRepository(ChatRoom);
    if (ws?.alerts_chat_room_id) {
      const configured = await roomRepo.findOne({ where: { id: ws.alerts_chat_room_id, workspace_id: workspaceId } });
      if (configured) return configured.id;
    }
    const fallback = await roomRepo
      .createQueryBuilder('r')
      .where('r.workspace_id = :wsId', { wsId: workspaceId })
      .orderBy('r.created_at', 'ASC')
      .limit(1)
      .getOne();
    return fallback?.id ?? null;
  }

  /** First `kind='intake'` column (Backlog) on the board; else the first
   *  active non-terminal column (mirrors OutreachIngestService._resolveColumn);
   *  else null. Deliberately never falls back to a terminal column — a ticket
   *  landing there is invisible to every dispatch path. */
  private async _resolveTargetColumn(boardId: string): Promise<BoardColumn | null> {
    const cols = await this.dataSource.getRepository(BoardColumn).find({
      where: { board_id: boardId },
      order: { position: 'ASC' },
    });
    return cols.find((c) => c.kind === 'intake')
      || cols.find((c) => c.kind === 'active' && !isTerminalColumn(c))
      || cols.find((c) => !isTerminalColumn(c))
      || null;
  }

  private _buildTicketDescription(target: MonitorTarget, workflow: GitHubWorkflow, evalResult: RedStreakResult, now: Date): string {
    const ageH = evalResult.firstFailedRun
      ? Math.max(0, (now.getTime() - new Date(evalResult.firstFailedRun.updated_at).getTime()) / 3_600_000)
      : 0;
    const lines = [
      `main CI(\`${workflow.name}\`, workflow ${workflow.id})가 \`${target.repoFullName}@${target.branch}\`에서 연속 ${evalResult.streak}회 실패했습니다(최초 실패 후 약 ${ageH.toFixed(1)}시간 경과).`,
      '',
      `이 보드는 use_pr=false라 CI 실패가 PR 체크로 노출되지 않습니다 — 원인을 조사해 고쳐주세요.`,
      '',
      evalResult.lastRun?.html_url ? `최신 run: ${evalResult.lastRun.html_url}` : '',
      '',
      `자동 생성: CiHealthMonitorService (ticket #[ticket:cc1c494e-b1ae-4e9c-a364-7323071492c0|main CI가 use_pr=false 환경에서 장기간 red여도 아무도 인지 못 함 — 상태 가시성 장치 필요])`,
    ].filter((l) => l !== undefined);
    return lines.join('\n');
  }

  private async _createOrReuseTicket(
    board: Board,
    target: MonitorTarget,
    workflow: GitHubWorkflow,
    evalResult: RedStreakResult,
  ): Promise<string | null> {
    const column = await this._resolveTargetColumn(board.id);
    if (!column) {
      this.logService.warn('CI', 'no non-terminal column available for CI-red ticket — skipping creation', {
        board_id: board.id,
      });
      return null;
    }
    const now = new Date();
    const dedupeKey = `ci_red:${board.id}:${target.repoFullName}:${target.branch}:${workflow.id}`;
    const title = `CI red: ${target.repoFullName}@${target.branch} — ${workflow.name}`;
    const description = this._buildTicketDescription(target, workflow, evalResult, now);
    try {
      return await this._insertTicket(board, column, dedupeKey, title, description);
    } catch (e) {
      if (!isUniqueConstraintError(e)) throw e;
      return await this._resolveTicketDedupeCollision(board, column, dedupeKey, title, description, e);
    }
  }

  private async _insertTicket(
    board: Board, column: BoardColumn, dedupeKey: string, title: string, description: string,
  ): Promise<string> {
    const { ticket, activityLog } = await this.dataSource.transaction(async (manager) => {
      const tRepo = manager.getRepository(Ticket);
      const position = await maxTicketPosition(manager, column.id);
      const savedTicket = await tRepo.save(tRepo.create({
        column_id: column.id,
        workspace_id: board.workspace_id || '',
        title,
        description,
        priority: 'high',
        labels: JSON.stringify(['ci-red', 'auto-generated']),
        channel_ids: '[]',
        position,
        created_by: 'CiHealthMonitor',
        created_by_type: 'system',
        created_by_id: '',
        operational_dedupe_key: dedupeKey,
      }));
      const savedActivity = await this.activityService.logActivityTx(manager, {
        entity_type: 'ticket',
        entity_id: savedTicket.id,
        action: 'created',
        ticket_id: savedTicket.id,
        actor_name: 'CiHealthMonitor',
      });
      return { ticket: savedTicket, activityLog: savedActivity };
    });
    this.activityService.emitLogged([activityLog]);

    // Board default role holders only — an auto-filed ticket names no
    // assignee, so a role stays vacant unless the board configures a
    // default_role_assignments backfill (mirrors OutreachIngestService /
    // BacklogPromotionService's bb5b9aed precedent: an unstaffed role means
    // nobody ever picks the ticket up).
    try {
      const defaults = parseDefaultRoleAssignments(board.default_role_assignments);
      if (Object.keys(defaults).length > 0) {
        await this.roleAssignmentService.applyBoardDefaults(ticket.id, board.workspace_id || '', defaults);
      }
    } catch {
      /* non-fatal — degrade to "no defaults" */
    }
    return ticket.id;
  }

  /**
   * _insertTicket()'s INSERT hit the operational_dedupe_key unique index —
   * another sweep (this process re-entering before the previous tick
   * finished, or a second instance) already won this episode's key. Reuse
   * the open winner; an archived legacy holder has its key released and
   * creation retried once. Mirrors OutreachIngestService._resolveDedupeCollision
   * exactly (ticket cc1c494e Plan decision D — INSERT-first, never a
   * pre-SELECT / compensating-delete dance).
   */
  private async _resolveTicketDedupeCollision(
    board: Board, column: BoardColumn, dedupeKey: string, title: string, description: string, originalError: unknown,
  ): Promise<string | null> {
    const ticketRepo = this.dataSource.getRepository(Ticket);
    const openWinner = await ticketRepo.findOne({ where: { operational_dedupe_key: dedupeKey, archived_at: IsNull() } });
    if (openWinner) return openWinner.id;

    const holder = await ticketRepo.findOne({ where: { operational_dedupe_key: dedupeKey } });
    if (!holder) throw originalError; // holder vanished mid-race — propagate, caller retries next sweep
    if (!holder.archived_at) return holder.id; // committed between our two lookups — reuse it

    holder.operational_dedupe_key = null;
    await ticketRepo.save(holder);
    try {
      return await this._insertTicket(board, column, dedupeKey, title, description);
    } catch (retryError) {
      if (!isUniqueConstraintError(retryError)) throw retryError;
      const fallbackWinner = await ticketRepo.findOne({ where: { operational_dedupe_key: dedupeKey, archived_at: IsNull() } });
      if (fallbackWinner) return fallbackWinner.id;
      throw retryError;
    }
  }
}
