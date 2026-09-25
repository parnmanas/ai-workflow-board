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
 * `event === 'schedule'`인 run, 그리고 event가 빈 문자열(누락)인 run도 동일하게 신호에서
 * 제외된다(fail-closed) — cron 트리거 run은 대부분의 잡이 skip돼도 run-level conclusion은
 * success로 찍히고, wire 경로에서 event 필드가 유실되면 그 판별 자체가 불가능해지기
 * 때문이다(ticket 654465c8, 리뷰 지적).
 *
 * 복구는 **단조적**이다 (ticket 0ef405f9): "최신 완료 run이 success" 는 필요조건일 뿐이고,
 * 그 success run이 이 행이 red 근거로 기록해 둔 실패 run(`last_run_id`/`last_run_at`)보다
 * 엄격히 최신일 때만 복구로 인정한다. 복구는 durable 상태(행 삭제 + 추적 티켓 연결 해제)를
 * 파괴하는 전이인데 판단 근거는 목록 API의 단발 응답 하나뿐이라, 그 응답이 한 번만
 * 어긋나도(다른 workflow의 run 혼입 · 최신 run 누락 · 같은 초 생성 run의 순서 뒤집힘) 곧장
 * 가짜 복구가 된다 — 실제로 성공 run이 0건인 main에 복구 알림이 두 차례 발송됐다. 하한선을
 * 통과하지 못한 green은 알림도 상태 변경도 없이 'CI' warn 로그 + `stale_green_rejected`
 * 카운터로만 관측된다. 같은 run의 재실행 flip(run id 동일)은 진짜 복구이므로 통과시킨다.
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
import { GitHubConnectorService, GitHubRateLimitError, GitHubWorkflow, GitHubWorkflowRun, parseGitHubUrl, sortWorkflowRunsNewestFirst } from '../../services/github-connector.service';
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
  /** 최신 signal run 이 success 였지만 기존 red 근거보다 최신이 아니라 복구로 인정하지
   *  않은 run. null 이 아니면 이번 응답이 앞뒤가 맞지 않았다는 뜻이며, 호출자는 기존
   *  상태를 그대로 두고 관측 가능하게 로그를 남겨야 한다 (ticket 0ef405f9). */
  staleGreenRun: GitHubWorkflowRun | null;
}

/**
 * 복구 판정의 하한선 — 직전 평가가 red 의 근거로 기록해 둔 실패 run.
 * `CiRedAlert` 행의 `last_run_id` / `last_run_at` 을 그대로 넘긴다.
 */
export interface RedStreakEvidence {
  lastFailedRunId: string;
  /** 그 run 의 `created_at` (ISO). 빈 문자열이면 하한선이 없다는 뜻이고 게이트는 적용되지 않는다. */
  lastFailedAt: string;
}

/**
 * 복구 단조성 게이트 — CI 상태를 green 으로 되돌리려면 그 근거가 red 를 만든 근거보다
 * **엄격히 최신**이어야 한다 (ticket 0ef405f9).
 *
 * 왜 필요한가: 복구 판정은 filtered 목록 API 의 단발 응답 하나만 보고 durable 상태
 * (`CiRedAlert` 행 + 추적 티켓 연결)를 지운다. 그 응답이 한 번만 어긋나면 — 다른
 * workflow 의 run 이 섞이든, 최신 run 이 빠지든, 같은 초에 생성된 run 의 순서가 뒤집히든
 * — 그 한 번이 그대로 "복구" 가 되고, 감시 상태까지 함께 사라진다. 실제로 성공 run 이
 * 하나도 없는 main 에 복구 알림이 두 차례 발송됐다. 근거가 기존 실패보다 최신이 아니면
 * 그것은 복구가 아니라 앞뒤가 맞지 않는 읽기이므로 red 를 유지한다.
 *
 * 같은 `created_at` 도 복구가 아니다 — 한 푸시가 동시에 띄운 형제 run 은 그 실패를
 * *뒤이어* 고친 run 이 아니라 나란히 돈 run 이기 때문이다. 그래서 비교는 `>` 이지 `>=` 가
 * 아니다.
 *
 * 예외 하나: **같은 run 이 재실행되어 green 으로 뒤집힌 경우**(`run_attempt` 증가)는 진짜
 * 복구다. run id 가 같고 `created_at` 도 그대로이므로 시각 비교만으로는 영원히 거부돼
 * 행이 갇힌다 — id 일치를 먼저 확인해 통과시킨다.
 */
function isRecoveryNewerThanEvidence(green: GitHubWorkflowRun, evidence?: RedStreakEvidence | null): boolean {
  const floorIso = evidence?.lastFailedAt || '';
  if (!floorIso) return true; // 하한선 자체가 없음 — 비교 대상이 없으므로 게이트하지 않는다
  if (evidence?.lastFailedRunId && green.id === evidence.lastFailedRunId) return true; // 같은 run 의 재실행 flip
  const floorMs = new Date(floorIso).getTime();
  if (!Number.isFinite(floorMs)) return true; // 하한선을 못 읽으면 게이트 근거가 없다
  const greenMs = new Date(green.created_at || '').getTime();
  if (!Number.isFinite(greenMs)) return false; // 시점을 못 읽는 run 으로는 복구를 주장할 수 없다
  return greenMs > floorMs;
}

/**
 * Pure red-streak decision — no DB, no HTTP — so the threshold logic is
 * deterministically unit-testable against fixture run lists. `runs` is
 * already narrowed to one workflow + branch; 최신순은 응답 순서를 믿지 않고
 * `sortWorkflowRunsNewestFirst` 로 (created_at, run id) 에서 다시 만든다.
 *
 * `evidence` 를 넘기면 복구 판정에 단조성 게이트가 걸린다 — `isRecoveryNewerThanEvidence`
 * 참고. 넘기지 않으면(하한선 없음) 기존 동작 그대로다.
 */
export function evaluateRedStreak(
  runs: GitHubWorkflowRun[],
  now: Date,
  config: { minConsecutiveRuns: number; minAgeMs: number },
  evidence?: RedStreakEvidence | null,
): RedStreakResult {
  // schedule(cron) 트리거 run은 워크플로 대부분의 잡이 `if: ... != 'schedule'`로 skip되지만
  // run-level conclusion은 그대로 success로 찍힌다 — signal에서 통째로 제외해 잡 5/6 skip인
  // run이 진짜 복구로도, 스트릭 브레이커로도 오판되지 않게 한다(ticket 654465c8). event가 빈
  // 문자열(누락)인 run도 같은 이유로 제외한다(fail-closed) — schedule 여부를 확인할 수 없는
  // run을 신호로 받아들이면, wire 경로에서 event 필드가 유실되는 순간 이 수정 자체가
  // 조용히 무력화된다(리뷰 지적).
  // 응답이 준 순서는 쓰지 않는다 — "가장 최신 run" 은 데이터(created_at, run id)에서
  // 다시 만든다 (ticket 0ef405f9).
  const ordered = sortWorkflowRunsNewestFirst(runs || []);
  const signal = ordered.filter((r) => SIGNAL_CONCLUSIONS.has(r.conclusion || '') && !!r.event && r.event !== 'schedule');
  if (signal.length === 0) {
    return { isRed: false, isGreen: false, streak: 0, firstFailedRun: null, lastRun: null, staleGreenRun: null };
  }
  const lastRun = signal[0];
  if (lastRun.conclusion === 'success') {
    if (!isRecoveryNewerThanEvidence(lastRun, evidence)) {
      // 복구로도 red 로도 넘기지 않는다 — 기존 상태를 그대로 유지시키고, 호출자가
      // 이 앞뒤 안 맞는 읽기를 관측할 수 있게 run 만 실어 보낸다.
      return { isRed: false, isGreen: false, streak: 0, firstFailedRun: null, lastRun, staleGreenRun: lastRun };
    }
    return { isRed: false, isGreen: true, streak: 0, firstFailedRun: null, lastRun, staleGreenRun: null };
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
  return { isRed, isGreen: false, streak, firstFailedRun, lastRun, staleGreenRun: null };
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
  /** 최신 run 이 success 로 보였지만 기존 red 근거보다 최신이 아니라 복구로 인정하지 않은
   *  횟수 (ticket 0ef405f9). 0 이 아니면 GitHub 응답이 그 sweep 에서 앞뒤가 맞지 않았다는
   *  뜻이다 — 알림은 나가지 않지만 'CI' 카테고리 warn 로그로 남는다. */
  stale_green_rejected: number;
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
      stale_green_rejected: 0,
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
        // 평가는 `_applyEvaluation` 안에서 한다 — 복구 단조성 게이트의 하한선이 기존
        // `CiRedAlert` 행에 있으므로, 행을 먼저 읽은 뒤에야 올바른 평가가 가능하다
        // (ticket 0ef405f9).
        await this._applyEvaluation(board, target, workflow, runs, now, stats);
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
    runs: GitHubWorkflowRun[],
    now: Date,
    stats: CiSweepStats,
  ): Promise<void> {
    const alertRepo = this.dataSource.getRepository(CiRedAlert);
    const existing = await alertRepo.findOne({
      where: { board_id: board.id, repo_full_name: target.repoFullName, branch: target.branch, workflow_id: workflow.id },
    });

    const evalResult = evaluateRedStreak(
      runs,
      now,
      { minConsecutiveRuns: this.config.minRuns, minAgeMs: this.config.minAgeMs },
      existing ? { lastFailedRunId: existing.last_run_id || '', lastFailedAt: existing.last_run_at || '' } : null,
    );

    if (evalResult.staleGreenRun) {
      // 응답의 최신 run 이 success 로 보였지만 기존 red 근거보다 최신이 아니다. 알림도
      // 보내지 않고 행도 건드리지 않는다 — 다만 조용히 넘기면 이 모니터가 잡으라고
      // 존재하는 바로 그 "아무도 모르는" 실패가 되므로 반드시 남긴다 (ticket 0ef405f9).
      stats.stale_green_rejected += 1;
      this.logService.warn('CI', 'CI 복구 신호를 거부했다 — 기존 red 근거보다 최신이 아니다 (상태 유지)', {
        board_id: board.id, repo: target.repoFullName, branch: target.branch,
        workflow_id: workflow.id, workflow_name: workflow.name,
        green_run_id: evalResult.staleGreenRun.id,
        green_run_created_at: evalResult.staleGreenRun.created_at,
        green_run_url: evalResult.staleGreenRun.html_url,
        recorded_last_run_id: existing?.last_run_id || '',
        recorded_last_run_at: existing?.last_run_at || '',
      });
      return;
    }

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
    // 이 시점의 `lastRun` 은 red 를 성립시킨 가장 최신 실패 run 이다 — 그 생성 시각이
    // 다음 sweep 의 복구 단조성 하한선이 된다 (ticket 0ef405f9).
    row.last_run_at = evalResult.lastRun?.created_at || '';
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
