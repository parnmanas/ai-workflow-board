// Owns the lifecycle of CLI subagent child processes (one-shot trigger / chat).
//
// Parameterized by a CliAdapter — the adapter contributes argv shape,
// mcp-config requirement, stream parsing, and one-shot result aggregation.
// For non-MCP adapters (antigravity, …) the manager:
//   - Skips the per-spawn mcp-config tempfile (adapter.needsMcpConfig=false)
//   - Captures stdout lines into the record so collectOneshotResult() can
//     produce a final answer at exit time
//   - Posts that answer back to AWB via the MCP `add_comment` tool when the
//     spawn carried a ticketId

import { promises as fsp } from 'node:fs';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { type ChildProcess } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import {
  SUBAGENTS_BASE_DIR,
  SUBAGENTS_PERSIST_PATH,
  TTL_SWEEP_INTERVAL_MS,
  SIGTERM_GRACE_MS,
  STOP_GRACE_MS,
  STOP_FORCE_KILL_SETTLE_MS,
} from './constants.js';
import { log } from './logging.js';
import { resolveBinOverride } from './cli-resolver.js';
import { createRuntimeAdapterResolver } from './runtime/runtime-registry.js';
import { spawnFailureTracker } from './spawn-failure-tracker.js';
import {
  ADAPTER_CAPABILITIES,
  type CliAdapter,
  type CliProgressEvent,
  type CliUsageSnapshot,
  describeHarness,
  partitionHarness,
  resolveModelChain,
  selectEffortSlice,
} from './cli-adapters/base.js';
import { accumulateUsage } from './cli-usage-accumulator.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { mcpConfigPathFor, writeMcpConfig } from './managed-agent-store.js';
import { classifyCliError, isFallbackEligible, hasUntrustedWorkspaceWarning } from './cli-error-signatures.js';
import { classifySpawnException } from './dispatch-preflight.js';
import { detectHarnessSessionLimit, resolveDeferUntil } from './session-limit-defer.js';
import type { HarnessSessionLimitDetection } from './session-limit-defer.js';
import { summarizeCliJsonLine } from './cli-output-summary.js';
import {
  resolveClaudeExecutionEffort,
  resolveMaxOutputTokensEnv,
  resolveToolProfileHeader,
  runtimeCredentialEnv,
  startRuntimeProfile,
  type MaxOutputTokensResolution,
  type RuntimeLease,
} from './runtime-profiles.js';
import { callMcpTool, fireAndForgetTool, unwrapToolResult } from './mcp-client.js';
import { resolveRunCompletionRoute } from './run-provisioner.js';
import {
  findLiveBackgroundTasks,
  findLiveGroupBackgroundTasks,
  reapProcessTrees,
  type ProcNode,
} from './process-tree.js';
import {
  completeMentionAuditRun,
  failMentionAuditRetrySpawn,
  postChatRoomMessage,
  postSilentExitSystemComment,
  startMentionAuditRun,
  type AwbConfig,
} from './rest.js';
import {
  ensureOperationalFallbackTicket,
  ensureOrdinaryWorkFallbackTicket,
  parseOperationalFallback,
  parseOrdinaryWorkFallback,
} from './operational-chat-fallback.js';
import type {
  SubagentManager as SubagentManagerContract,
  SubagentSpawnArgs,
  SubagentSpawnResult,
} from './event-dispatcher.js';
import type { RunSessionBinding } from './base-session-manager.js';
import type { SubagentMonitor, SubagentTapHandle } from './subagent-monitor.js';

const { NATIVE_MCP } = ADAPTER_CAPABILITIES;

/** Max lines kept in the per-pid plain-text tail ring used by the
 *  silent-exit fallback. Bounded so a chatty subagent can't blow the
 *  manager's memory if it never exits cleanly. */
const TAIL_RING_MAX_LINES = 100;
/** Max bytes of `tail.join('\n')` posted in the silent-exit system
 *  comment. 4KB keeps the comment readable in the board UI. */
const SILENT_EXIT_TAIL_MAX_CHARS = 4096;
/** Max per-pid detail lines embedded in a one-shot run's orphan-sweep summary
 *  (ticket 55d3063f). Mirrors ChatSessionManager's ORPHAN_SUMMARY_MAX_DETAIL —
 *  the full pid list is always included; this only caps the cmd detail. */
const ORPHAN_SUMMARY_MAX_DETAIL = 5;
/** Chat one-shot progress heartbeats (ticket c47194d9 — Codex). Values mirror
 *  ChatSessionManager's PROGRESS_* constants so a Codex chat and a Claude chat
 *  coalesce + cap their progress identically. */
const CHAT_PROGRESS_MIN_INTERVAL_MS = 1500;
const CHAT_PROGRESS_MAX_PER_SESSION = 30;
const CHAT_PROGRESS_DETAIL_MAX = 80;
const CHAT_PROGRESS_LABEL_MAX = 40;
/** MCP tool name suffixes that count as the subagent leaving a real
 *  audit-trail entry. Matched by suffix so a future MCP prefix rename
 *  doesn't break detection. Keep aligned with the ticket-session list.
 *  `move_ticket` resolves to a system "moved from X to Y" Comment row
 *  instead of an agent-authored one (ticket 2fd06686) — a one-shot that
 *  only moved the ticket is not "silent". This is a fast-path optimization
 *  only — `#postSilentExitFallback`'s caller re-verifies against the
 *  server when this local scan comes up empty. */
const TICKET_COMMENT_TOOL_SUFFIXES = [
  'add_comment',
  'ask_question',
  'answer_question',
  'record_decision',
  'handoff_to_agent',
  'move_ticket',
];

/** Minimal identity shape the dedup scan reads off both live SubagentRecords
 *  and in-flight ReservationRecords. */
interface SpawnIdentityRecord {
  trigger_id?: string | null;
  chat_request_id?: string | null;
  ticket_id?: string | null;
  role?: string | null;
  agent_id?: string | null;
}

/**
 * Decide whether a spawn `spec` duplicates an existing record / reservation.
 * Pure so it can be unit-tested without forking a CLI child. Three rules,
 * first match wins:
 *   1. Exact trigger idempotency — same non-empty triggerId (redelivered
 *      agent_trigger / SSE replay).
 *   2. Exact chat idempotency — same non-empty chatRequestId.
 *   3. (ticket, role, agent) single-flight — a column `trigger` spawn whose
 *      (ticketId, role) matches any live record / in-flight reservation
 *      collapses onto it, REGARDLESS of triggerId. The one-shot path can't
 *      deliver a follow-up turn the way the persistent ticket-session path does
 *      (which reuses the live pid), so the closest single-flight analog is to
 *      drop the second spawn while a strand for the same key is alive. This is
 *      the fix for the VEG-R2-5 duplicate-strand race: two DISTINCT non-empty
 *      trigger ids for the same (ticket, role) seconds apart used to each pass
 *      rule 1 (ids differ) and the old empty-triggerId-only fallback,
 *      twin-spawning two live strands. A genuine sequential re-trigger still
 *      spawns: once the prior strand exits its record leaves `#map`, so nothing
 *      matches. Restricted to `trigger` kind so chat spawns (no role) are never
 *      merged on a blank role.
 *
 *      다중담당자 팬아웃(T2/T7): 같은 (ticket, role)이라도 **서로 다른 holder
 *      agent** 의 스폰은 중복이 아니라 각 홀더의 몫이다 — 합의는 전 홀더의
 *      record_agreement 를 요구하므로 두 번째 홀더를 drop 하면 데드락된다.
 *      양쪽 agent id 가 모두 알려졌고 서로 다를 때만 통과시키고, 어느 한쪽이라도
 *      미상이면 종전대로 collapse(레거시 무회귀).
 *
 *      EXCEPTION — comment-mention spawns (`triggerId` of the form
 *      `mention:<commentId>:<agentId>`, see {@link mentionTriggerId}) are NOT
 *      coalesced here. A distinct @-mention is NEW work (a reviewer's question
 *      to the assignee, etc.), not a duplicate re-trigger: the one-shot strand
 *      can't receive a follow-up turn and its prompt is frozen at spawn, so
 *      dropping the mention would silently lose the comment. Rule 1 still
 *      dedupes an exact redelivery of the same `(commentId, agent)`; only
 *      genuinely-new mentions are allowed past this gate. The **agent 차원**이
 *      id 에 없으면(구 `mention:<commentId>`) role 멘션(@[role:assignee])의
 *      공동 홀더 팬아웃 — per-agent SSE 가 같은 commentId 로 홀더 수만큼
 *      도착한다 — 이 rule 1 에 걸려 두 번째 홀더 스폰이 drop, 그 홀더가
 *      합의 논의에서 배제된다(T7 리뷰 blocker #2).
 * Returns the drop reason or `false` when the spawn is unique.
 */
export function findDuplicateSpawn(
  records: Iterable<SpawnIdentityRecord>,
  spec: {
    kind: 'trigger' | 'chat';
    triggerId?: string;
    chatRequestId?: string;
    ticketId?: string;
    role?: string;
    agentId?: string;
  },
): false | 'duplicate_trigger' | 'duplicate_chat' {
  const specRole = spec.role || '';
  const specAgent = spec.agentId || '';
  for (const rec of records) {
    if (spec.triggerId && rec.trigger_id === spec.triggerId) {
      return 'duplicate_trigger';
    }
    if (spec.chatRequestId && rec.chat_request_id === spec.chatRequestId) {
      return 'duplicate_chat';
    }
    if (
      spec.kind === 'trigger' &&
      !(spec.triggerId || '').startsWith('mention:') &&
      spec.ticketId &&
      rec.ticket_id === spec.ticketId &&
      (rec.role || '') === specRole &&
      // 서로 다른 holder agent(양쪽 모두 식별된 경우)는 별개 스폰 — 팬아웃.
      (!specAgent || !(rec.agent_id || '') || (rec.agent_id || '') === specAgent)
    ) {
      return 'duplicate_trigger';
    }
  }
  return false;
}

/**
 * comment-mention one-shot 의 triggerId — **per-(comment, target agent)** 차원.
 * 서버 comment_mention 은 per-agent 스코프 SSE 라 role 멘션의 공동 홀더 수만큼
 * 같은 commentId 이벤트가 도착한다. agent 무차원 id(`mention:<commentId>`)는
 * findDuplicateSpawn rule 1(exact trigger_id)에 걸려 두 번째 홀더 스폰이 drop —
 * 합의(전 홀더 record_agreement)가 데드락된다. agent 차원을 붙이면 rule 1 은
 * 같은 (comment, agent) 재전달만 정확히 dedup 한다. agentId 미상이면 종전
 * collapse 형태(`mention:<commentId>:`)로 접혀 레거시 무회귀. rule 3 의 mention
 * 예외(`startsWith('mention:')`)는 접두 형태가 같아 그대로 작동한다.
 */
export { mentionTriggerId } from './trigger-id.js';

export interface SubagentDelegationConfig {
  enabled?: boolean;
  maxConcurrent?: number;
  ttlMinutes?: number;
  claudeBin?: string;
  codexBin?: string;
  /** ticket b972b28c: hours a one-shot may keep sliding its TTL on live
   *  background-task evidence before #sweep logs a ONE-TIME runaway-loop
   *  escalation. Never kills — mirrors BaseSessionManager's
   *  progressEscalationHours governing principle (ticket 6ff827cb): real
   *  progress evidence is never grounds to reap, only to notify. Default 4h
   *  (see DELEGATION_DEFAULTS in constants.ts). */
  subagentProgressEscalationHours?: number;
}

export interface SubagentAwareConfig extends AwbConfig {
  delegation: SubagentDelegationConfig;
}

interface ReservationRecord {
  kind: 'reservation';
  started_at: number;
  // Identity carried on the reservation so the dedup scan can catch a second
  // near-simultaneous spawn DURING the spawn window — before the real
  // SubagentRecord lands in `#map`. Without these, two concurrent spawns for
  // the same trigger / (ticket,role) both pass the dedup scan (which used to
  // skip reservations) and twin-spawn.
  trigger_id?: string | null;
  chat_request_id?: string | null;
  ticket_id?: string | null;
  role?: string | null;
  // 다중담당자 팬아웃: 같은 (ticket, role)의 다른 holder agent 스폰을 중복으로
  // 오인해 drop 하지 않도록 reservation 에도 agent 신원을 실어 둔다.
  agent_id?: string | null;
}

interface SubagentRecord {
  kind: 'trigger' | 'chat';
  pid: number;
  cli_type: string;
  trigger_id: string | null;
  audit_session_id?: string;
  mention_audit_run_token?: string;
  silent_exit_attempt?: 0 | 1;
  silent_exit_terminal_reason?: string;
  silent_exit_family_key?: string;
  chat_request_id: string | null;
  ticket_id: string | null;
  agent_id: string | null;
  /** Workspace role slug the spawn acted as (assignee / reviewer / …). Mirrors
   *  the role pinned onto the per-spawn mcp-config. Captured so stopForAgent
   *  can report the in-flight (ticket, role) pair a killed zombie was holding,
   *  which restart_agent re-pushes for immediate resume. Empty for chat /
   *  non-role spawns. */
  role: string | null;
  room_id: string | null;
  started_at: number;
  expected_completion_at: number;
  /** ticket b972b28c: set once #maybeEscalateLongRunning has logged its
   *  one-time runaway-loop notice for this record, so repeated sweep ticks
   *  don't spam the log while a genuinely long-running one-shot keeps
   *  producing live-background-task evidence. */
  progressEscalatedAt?: number;
  config_path: string | null;
  /** ST-6: false when config_path is a managed-agent's persistent
   *  mcp-config.json file we must NOT unlink on subagent exit / cleanup. */
  config_path_is_temp: boolean;
  process_handle: ChildProcess | null;
  captureOutput: boolean;
  outLines: string[];
  /** Plain-text stdout / stderr tail for silent-exit fallback. Captured
   *  for every ticket spawn regardless of `captureOutput` (which gates the
   *  non-MCP one-shot answer aggregation). Cleared on exit-handler cleanup. */
  tailLines: string[];
  /** True once we observed an MCP tool_use call that creates a ticket
   *  comment (add_comment / ask_question / answer_question /
   *  record_decision / handoff_to_agent), OR — for non-NATIVE_MCP one-shot
   *  paths — once `#postOneshotAnswer` succeeded. Skipping the silent-exit
   *  fallback when this is true keeps clean cycles quiet. */
  commentSent: boolean;
  tap: SubagentTapHandle | null;
  /** Running token/cost total accumulated across every `result` /
   *  `turn.completed` stdout line observed for this run (ticket 6dd3f968).
   *  A one-shot normally sees at most one such event, but accumulation is
   *  the same fold used by persistent sessions — see `#captureUsageLine`.
   *  Plain data (survives #persist, unlike the function-valued fields
   *  below), sent on the tap's `end()` call in the exit handler. */
  usage: CliUsageSnapshot | null;
  /** 폴백 모델 체인 (ticket 61f4dd18). head=주 모델(null=CLI 기본), 이후는
   *  우선순위 순 폴백. 길이 1 이면 폴백 없음. */
  modelChain?: (string | null)[];
  /** 이번 spawn 이 사용한 modelChain 인덱스. 0=주 모델. */
  chainAttempt?: number;
  /** 원본 spawn 인자. exit 핸들러가 폴백-적격 실패 + 산출물 없음일 때 다음
   *  모델로 재-spawn 하기 위해 보관. 런타임 전용 — #persist 시 제외한다. */
  respawnSpec?: SubagentSpawnArgs;
  /** ticket e9d0e8bc: run-lifetime folder-lock release, fired once from the
   *  exit handler. Captured in the handler closure so a force-drop of this
   *  record by a kill/reaper path still releases the lock. 런타임 전용. */
  onSpawnExit?: () => void;
  /** ticket 55d3063f: QA/security run this one-shot is executing, when the
   *  spawn was a run dispatch (codex/antigravity or declined-persistent
   *  fallback). Present → the exit handler sweeps the turn end for orphaned
   *  background tasks and finalizes a stranded run as `error`. Plain data, so
   *  it survives #persist (unlike onSpawnExit, a function). */
  run?: RunSessionBinding | null;
  /** ticket 6abe2b79: stop() 가 SIGTERM 을 보내기 *전에* 살아있는 모든 victim
   *  레코드에 세팅한다 — BaseSessionManager 의 sess.stopReason(ticket b831b896)
   *  과 동일한 규약. _handleOneshotExit 이 이 값을 보고 circuit-breaker/
   *  silent-exit 오탐 로직을 건너뛰고(배달 실패가 아니므로), _runExitCompletionBackstop
   *  이 추측 대신 실제 사유를 보고한다 — 매니저 shutdown 으로 죽은 oneshot
   *  Action/QA run 이 서버의 TTL reaper 까지 `running` 으로 방치되지 않고
   *  정확히 보고되게 한다. */
  stopReason?: string | null;
}

type AnyRecord = SubagentRecord | ReservationRecord;

export interface SubagentExitInfo {
  pid: number;
  record: SubagentRecord;
  code: number | null;
  signal: NodeJS.Signals | null;
  durationSec: number;
}

/** A (ticket, role) pair a killed subagent was mid-flight on. Returned by
 *  stopForAgent so restart_agent can immediately re-push the trigger on the
 *  fresh credential instead of waiting for the server supervisor's ~30-min
 *  stale sweep. `room_id` is carried for diagnostics (chat one-shots have no
 *  ticket); only entries with a ticket_id are re-pushable. */
export interface SubagentInflightWork {
  ticket_id: string | null;
  role: string | null;
  room_id: string | null;
}

export interface SubagentStopForAgentResult {
  count: number;
  inflight: SubagentInflightWork[];
}

export class SubagentManager implements SubagentManagerContract {
  #map = new Map<number, AnyRecord>();
  #config: SubagentAwareConfig;
  /**
   * ST-7 cli refactor: per-cliType adapter cache. The manager is no longer
   * pinned to a single CLI; spawn() resolves the right adapter from
   * `agentContext.cli` so a single manager host can drive a mix of
   * claude / codex / antigravity agents. createAdapter() runs at most once per
   * cli over the manager's lifetime.
   */
  #adapterResolver = createRuntimeAdapterResolver();
  #sweepTimer: NodeJS.Timeout | null = null;
  /** ticket b972b28c: #sweep's TTL branch now awaits an async live-task probe
   *  (findLiveBackgroundTasks shells out to `ps`) per TTL-expired candidate.
   *  Guards against the next setInterval tick re-entering #sweep while a
   *  prior pass is still mid-probe. A skipped tick is harmless — the next
   *  one TTL_SWEEP_INTERVAL_MS later just re-evaluates current state. */
  #sweepInFlight = false;
  /** ticket 6abe2b79: pid → resolver, stop() 호출 도중에만 살아있다. 실제 exit
   *  핸들러(#wireExitHandler)가 victim 의 post-exit 체인(정리 + run-completion
   *  backstop)이 실제로 끝나면 이 항목을 resolve + 삭제한다 — 그래서 stop() 이
   *  SIGKILL 보내자마자 반환하는 대신 실제 완료를 기다릴 수 있다(그 race 가 왜
   *  문제인지는 stop() 자체 docstring 참고 — SIGKILL 대상의 backstop 이 호출자의
   *  process.exit() 전에 못 끝날 수 있었다). */
  #stopWaiters = new Map<number, () => void>();
  #reservationCounter = 0;
  /**
   * ticket 6abe2b79 리뷰 라운드3: record.run 을 "완료 처리할 권리"로 원자적으로
   * 떼어낸다 — 읽기와 null 대입이 같은 동기 구간 안이라 그 사이에 다른 경로가
   * 끼어들 수 없다(JS 단일 스레드 특성상 await 없는 연속 statement 는 절대
   * 쪼개지지 않는다). 이 값을 쓰는 모든 completion 경로(#wireExitHandler 의
   * close 콜백, stop() 의 force-kill fallback)가 반드시 이 메서드로만
   * record.run 을 읽어야 한다 — 직접 `record.run` 을 읽고 그 값을 들고 await
   * 하면, await 도중 다른 경로가 같은 값을 또 읽어 complete_*_run 이 두 번
   * 호출되는 TOCTOU 경합이 생긴다(리뷰에서 실측 지적됨). null 을 반환하면 이미
   * 다른 경로가 가져갔다는 뜻 — 호출자는 즉시 스킵한다.
   */
  #claimRun(record: SubagentRecord): RunSessionBinding | null {
    const run = record.run ?? null;
    record.run = null;
    return run;
  }
  #persistPath: string;
  #pidDir: string;
  #initialized = false;
  #monitor: SubagentMonitor | null = null;
  /** Per-pid chat-progress emit state (ticket c47194d9). Keyed by the child pid
   *  (unique per spawn) so a chat one-shot gets its own rate-limit window + cap.
   *  Dropped on the child's exit (including drop-first kill paths). */
  #progressMeta = new Map<
    number,
    { lastEmitMs: number; count: number; errorEmitted: boolean }
  >();

  /** Circuit-breaker for the one-shot path. Blocks re-spawn to an (agent,
   *  ticket, role) that repeatedly exits with non-transient errors and pends
   *  the ticket when it opens — the same protection the persistent
   *  TicketSessionManager already had. Injected from main.ts so it is SHARED
   *  with the persistent path: a (ticket,role) that fails N times across both
   *  paths counts once, and restart_agent's resetAgent() clears both. Falls
   *  back to a private instance when constructed without one (unit tests). */
  readonly circuitBreaker: CircuitBreaker;

  onExit?: (info: SubagentExitInfo) => void;

  /** ticket 467f714a: notified when a one-shot ticket subagent dies on a harness
   *  session-limit signature, with the resolved reset instant. main.ts wires this
   *  to EventStream.recordHarnessSessionLimit (SAME store as the persistent path)
   *  so the dispatcher defers the agent's dispatch until reset instead of pending.
   *  Unset in harnesses that don't exercise the defer path. */
  onHarnessSessionLimit:
    | ((info: {
        agentId: string;
        ticketId: string;
        role: string;
        reason: string;
        resetLabel: string;
        deferUntilMs: number;
      }) => void)
    | null = null;

  constructor(config: SubagentAwareConfig, circuitBreaker?: CircuitBreaker) {
    this.#config = config;
    this.#persistPath = SUBAGENTS_PERSIST_PATH;
    this.#pidDir = SUBAGENTS_BASE_DIR;
    this.circuitBreaker = circuitBreaker ?? new CircuitBreaker();
  }

  setMonitor(monitor: SubagentMonitor | null): void {
    this.#monitor = monitor;
  }

  async init(): Promise<void> {
    if (this.#initialized) return;
    this.#initialized = true;
    try {
      await fsp.mkdir(this.#pidDir, { recursive: true, mode: 0o700 });
    } catch (err: any) {
      log(`SubagentManager: mkdir failed: ${err?.message ?? err}`);
    }
    await this.#reconcileOnStart();
    await this.#sweepOrphanCfgs();
    this.#sweepTimer = setInterval(() => {
      this.#sweep().catch((err: any) => log(`SubagentManager sweep failed: ${err?.message ?? err}`));
    }, TTL_SWEEP_INTERVAL_MS);
    this.#sweepTimer.unref?.();
    log(
      `SubagentManager initialized (per-agent cli, pidDir=${this.#pidDir}, cap=${this.#config.delegation.maxConcurrent}, ttl=${this.#config.delegation.ttlMinutes}min)`,
    );
  }

  /**
   * Resolve an adapter for the requested CLI, memoized so each cliType
   * only constructs once. Falls back to the claude adapter for missing /
   * unknown values (createAdapter handles that itself).
   */
  #adapterFor(cli: string | null | undefined): CliAdapter {
    return this.#adapterResolver.resolve(cli);
  }

  /** Default-claude adapter for the legacy single-agent code paths. */
  get adapter(): CliAdapter {
    return this.#adapterFor('claude');
  }

  async #sweepOrphanCfgs(): Promise<void> {
    let files: string[];
    try {
      files = await fsp.readdir(this.#pidDir);
    } catch (err: any) {
      log(`Orphan cfg sweep: readdir failed: ${err?.message ?? err}`);
      return;
    }

    const liveCfgs = new Set<string>();
    for (const rec of this.#map.values()) {
      if (rec.kind !== 'reservation' && rec.config_path) liveCfgs.add(rec.config_path);
    }
    try {
      const procEntries = await fsp.readdir('/proc');
      for (const entry of procEntries) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const cmdline = await fsp.readFile(`/proc/${entry}/cmdline`, 'utf8');
          const parts = cmdline.split('\0');
          const idx = parts.indexOf('--mcp-config');
          if (idx >= 0 && parts[idx + 1]) liveCfgs.add(parts[idx + 1]);
        } catch {
          /* process vanished mid-scan; ignore */
        }
      }
    } catch {
      /* /proc missing (non-Linux) — rely on persist-reconciliation only */
    }

    let purged = 0;
    for (const f of files) {
      if (!f.startsWith('cfg-') || !f.endsWith('.json')) continue;
      const path = join(this.#pidDir, f);
      if (liveCfgs.has(path)) continue;
      try {
        await fsp.unlink(path);
        purged++;
      } catch {
        /* vanished; ignore */
      }
    }
    if (purged > 0) log(`Orphan cfg sweep: purged ${purged} stale config file(s)`);
  }

  canSpawn(): boolean {
    const active = this.#activeCount();
    return active < (this.#config.delegation.maxConcurrent ?? 5);
  }

  #activeCount(): number {
    let n = 0;
    for (const _ of this.#map.values()) n++;
    return n;
  }

  async spawn(spec: SubagentSpawnArgs): Promise<SubagentSpawnResult> {
    // Single pass over both live records AND in-flight reservations (which now
    // carry identity) so concurrent dups collapse to the first spawn. Records
    // clear on child exit, so a later trigger for the same key after the first
    // child finished spawns fresh — there is no persistent remembered set to
    // leak (unlike the base-session dedup ring).
    const dup = findDuplicateSpawn(this.#map.values(), spec);
    if (dup) {
      return { spawned: false, reason: dup };
    }

    // Circuit-breaker gate (ticket 27806095): if this (agent, ticket, role)
    // has tripped the non-transient failure threshold — or hit a non-retryable
    // signature (codex usage-limit / auth) — drop the spawn so a CLI that dies
    // in 1–2s can't spin the trigger loop indefinitely. Mirrors the persistent
    // TicketSessionManager.dispatchTrigger gate. Restricted to ticket triggers
    // (chat one-shots have no role/loop to break).
    //
    // ticket 970d6692 (review round 2): when the caller already resolved this
    // for the SAME logical attempt (event-dispatcher's dispatchTrigger→
    // one-shot fallback — dispatchTrigger's own shouldBlock() already passed),
    // `spec.circuitBreakerDecision` carries that verdict and this gate MUST
    // NOT call shouldBlock() again. shouldBlock() grants at most one half-open
    // probe per cooldown window by stamping `lastProbeAt`; a second call here
    // for the same attempt would see its own just-granted stamp and re-block
    // the very attempt that was just cleared. Every other spawn() call site
    // (chat one-shots, mention triggers) never sets this field, so `undefined`
    // preserves the original self-contained check for them.
    if (spec.kind === 'trigger' && spec.ticketId && spec.agentId) {
      const cbKey = CircuitBreaker.key(spec.agentId, spec.ticketId, spec.role || '');
      const blockReason =
        spec.circuitBreakerDecision !== undefined
          ? spec.circuitBreakerDecision
          : this.circuitBreaker.shouldBlock(cbKey);
      if (blockReason) {
        log(
          `[subagent] spawn blocked by circuit-breaker: ticket=${spec.ticketId.slice(0, 8)} ` +
            `role=${spec.role || '_'} agent=${spec.agentId.slice(0, 8)} — ${blockReason}`,
        );
        return { spawned: false, reason: 'circuit_breaker_open' };
      }
    }

    if (!this.canSpawn()) {
      return { spawned: false, reason: 'cap_reached' };
    }
    const reservationId = -(++this.#reservationCounter);
    this.#map.set(reservationId, {
      kind: 'reservation',
      started_at: Date.now(),
      trigger_id: spec.triggerId || null,
      chat_request_id: spec.chatRequestId || null,
      ticket_id: spec.ticketId || null,
      role: spec.role || null,
      agent_id: spec.agentId || null,
    });

    // ST-6 / ST-7: per-call managed-agent context. When provided we
    // (a) reuse the pre-written mcp-config.json instead of a temp one,
    // (b) authenticate as the managed agent (apiKey override),
    // (c) cd into the managed agent's working_dir, and
    // (d) pick the adapter for the agent's CLI choice (claude/codex/antigravity)
    //     instead of using a manager-wide default.
    const ctx = spec.agentContext;
    const adapter = this.#adapterFor(ctx?.cli);
    const effectiveApiKey = ctx?.api_key || this.#config.apiKey;
    const effectiveCwd = ctx?.cwd || undefined;
    // Board/workspace harness (e9c7a896): keep the keys this adapter can
    // express, warn + skip the rest — a key the CLI can't map is a graceful
    // skip, never a refusal to spawn. harness.model (board-level intent)
    // beats the per-agent Agent.model default.
    const { applied: harness, skipped: harnessSkipped } = partitionHarness(adapter, spec.harness);
    if (harnessSkipped.length > 0) {
      log(
        `[subagent] harness keys skipped (cli=${adapter.cliType} can't express them): ${harnessSkipped.join(', ')}`,
      );
    }
    if (harness) {
      log(
        `[subagent] harness applied: ticket=${spec.ticketId.slice(0, 8) || '-'} cli=${adapter.cliType} ${describeHarness(harness)}`,
      );
    }
    // Ticket-level effort preset (parallel channel to harness). Pick this
    // adapter's slice: claude → { model?, effort?, ultracode? }; codex /
    // antigravity → { model? }; everything else → null. slice.model is the
    // board-level effort intent and WINS the model precedence over both the
    // harness model and the per-agent Agent.model default. effort / ultracode
    // only ever survive for claude (the codex/antigravity slices never carry
    // them); they ride into buildOneshotSpawn and are ignored by adapters that
    // don't destructure them.
    const slice = selectEffortSlice(adapter.cliType, spec.effortPreset);
    // Server-side resolution is Claude-only, but retain this guard for
    // compatibility with older servers and hand-built dispatch events.
    const claudeRuntimeProfile =
      adapter.cliType === 'claude' ? spec.runtimeProfile : null;
    // Ticket ee26302d: see base-session-manager.ts's identical comment —
    // `{}` (full) unless this profile's context_window is small.
    const toolProfileHeader = resolveToolProfileHeader(claudeRuntimeProfile);
    // Backend profile의 model은 그 endpoint와 분리될 수 없으므로 Anthropic
    // 지향 per-agent/harness model 기본값보다 우선한다. ticket 41dc37cb
    // round 3 — 운영에서 정상 동작이 검증된 claude-with-vllm.sh는
    // `--model`을 아예 넘기지 않는다; served model은 claudeEnv()의
    // ANTHROPIC_MODEL/ANTHROPIC_DEFAULT_*_MODEL 라우팅(runtime-profiles.ts)
    // 만으로 CLI에 전달된다. round 1/2의 CLI-recognized-alias 간접화는
    // 실제 운영 검증을 통과하지 못했으므로, profile이 활성화된 세션은
    // 이제 이 플래그를 항상 생략한다.
    const effectiveModel = claudeRuntimeProfile
      ? null
      : (slice?.model ?? harness?.model ?? ctx?.model ?? null);
    const effortFlag = resolveClaudeExecutionEffort(slice, claudeRuntimeProfile).effort;
    const ultracode = !!slice?.ultracode;
    if (slice && (effortFlag || ultracode || slice.model)) {
      log(
        `[subagent] effort applied: ticket=${spec.ticketId.slice(0, 8) || '-'} cli=${adapter.cliType} ` +
          `effort=${effortFlag ?? '-'} ultracode=${ultracode} model=${slice.model ?? '-'}`,
      );
    }
    // 폴백 모델 체인 (ticket 61f4dd18). 최초 spawn 은 effectiveModel(=주 모델)과
    // harness.fallback_models 로 체인을 만든다. 폴백 respawn 은 exit 핸들러가
    // _modelChain/_chainAttempt 를 넘겨오므로 그대로 이어쓴다. attemptModel 이
    // 이번 시도의 실제 모델(null=CLI 기본)이며 아래 buildOneshotSpawn 에 전달된다.
    // Claude backend profile이 활성화된 세션은 resolveModelChain()이
    // harness.fallback_models를 통째로 무시한다(ticket 41dc37cb 리뷰 라운드1) —
    // 이 profile은 endpoint 하나에 model 하나만 서빙하므로 "다른 모델로
    // 폴백"이 성립하지 않고, 그 raw 값들은 애초에 CLI-recognized alias로
    // 검증된 적도 없다.
    const modelChain =
      spec._modelChain ?? resolveModelChain(effectiveModel, claudeRuntimeProfile, spec.harness?.fallback_models);
    const chainAttempt = spec._chainAttempt ?? 0;
    const attemptModel = modelChain[chainAttempt] ?? null;
    if (modelChain.length > 1) {
      log(
        `[subagent] model chain: ticket=${spec.ticketId.slice(0, 8) || '-'} cli=${adapter.cliType} ` +
          `attempt=${chainAttempt + 1}/${modelChain.length} model=${attemptModel ?? '(default)'}`,
      );
    }
    let configPath: string | null = null;
    let configPathIsTemp = false;
    let runtimeLease: RuntimeLease | null = null;
    // ticket 7d8ea7c9 후속(컨텍스트 윈도우 초과) — profile.context_window 가
    // 설정된 경우에만 의미 있는 no-op-safe 계산. 예산 고갈 시
    // ContextBudgetExhaustedError 를 던질 수 있으므로(리뷰 지적, P1) try
    // 블록 안에서 계산해 아래 catch 가 startRuntimeProfile 실패와 동일하게
    // 잡아 spawn 을 정상적으로 실패 처리하게 한다.
    let maxOutputResolution: MaxOutputTokensResolution | null = null;
    try {
      if (claudeRuntimeProfile) {
        maxOutputResolution = resolveMaxOutputTokensEnv(claudeRuntimeProfile, {
          rolePrompt: spec.rolePrompt,
          harnessAppend: harness?.system_prompt_append,
          firstTurnText: spec.taskText,
        });
        runtimeLease = await startRuntimeProfile(
          claudeRuntimeProfile,
          runtimeCredentialEnv(claudeRuntimeProfile, ctx?.credential_id, ctx?.extra_env),
        );
        const est = maxOutputResolution.estimate;
        // 티켓 1af53029 — context_window 미설정 상태의 무음 로그를
        // base-session-manager.ts 와 동일하게 명시적 경고로 바꾼다.
        const budgetLog = maxOutputResolution.effectiveMaxOutputTokens !== null
          ? ` context_window=${claudeRuntimeProfile.context_window} known_input≈${est.known_total}` +
            `(role=${est.role_prompt} append=${est.harness_append} first_turn=${est.first_turn}) ` +
            `safety_margin=${maxOutputResolution.safetyMarginTokens} effective_max_output=${maxOutputResolution.effectiveMaxOutputTokens}`
          : ' context_window not set — no CLAUDE_CODE_MAX_OUTPUT_TOKENS clamp applied; ' +
            'a large first turn can silently exceed the backend context window and fail after a long timeout';
        log(
          `[subagent] Claude backend ready: profile=${claudeRuntimeProfile.id} protocol=${claudeRuntimeProfile.protocol}${budgetLog}`,
        );
      }
      // Establish the server-owned baseline before creating MCP attribution.
      // The returned token is the exact provenance attached to every write
      // performed by this process, isolating concurrent runs of the same
      // ticket/agent/role.
      const mentionAudit =
        spec.kind === 'trigger' &&
        spec.triggerId?.startsWith('mention:') &&
        spec.ticketId &&
        spec.agentId
          ? await startMentionAuditRun(this.#config, spec.ticketId, {
              cycle_trigger_id: spec.triggerId,
              agent_id: spec.agentId,
              role: spec.role,
              attempt: spec._silentExitAttempt ?? 0,
              subagent_session_id: String(reservationId),
            })
          : null;
      const attributedSpec = mentionAudit
        ? { ...spec, triggerSource: mentionAudit.run_token }
        : spec;
      const descriptor = this.#adapterResolver.buildOneshot(adapter.cliType, {
        rolePrompt: spec.rolePrompt || '',
        taskText: spec.taskText,
        mcpConfigPath: null,
        cwd: effectiveCwd,
        cliHomeDir: ctx?.cli_home_dir ?? null,
        mcpAttribution: this.#mcpAttribution(attributedSpec, !!ctx, String(reservationId)),
        model: attemptModel,
        harness,
        effort: effortFlag,
        ultracode,
      }).descriptor;

      if (descriptor.needsMcpConfig) {
        // Per-spawn role pin — same contract BaseSessionManager._spawnSession
        // uses. When a trigger / mention spawn carries (ticketId, role), the
        // server's resolveAuthorRole needs the X-AWB-Subagent-Role +
        // X-AWB-Subagent-Ticket-Id headers to attribute the spawned subagent's
        // comments to the single triggering role. The per-agent static
        // mcp_config_path only carries Authorization + X-AWB-Client-Type, so
        // we can't reuse it for role-pinned spawns; write a fresh temp config
        // instead. Non-role spawns (chat, no ticket) keep reusing the static
        // config to avoid the extra fs write.
        const needsSessionPin = !!(spec.ticketId && spec.role);

        if (ctx?.mcp_config_path && !needsSessionPin) {
          // Reuse the static per-agent mcp-config.json for non-role spawns.
          // Ticket ee26302d review round 2 (P1): see base-session-manager.ts's
          // identical branch — a single shared path with a rewrite-if-
          // mismatched-content check fixed sequential profile transitions
          // but not concurrent ones (no handshake confirms a CLI already
          // read the file before the next spawn can overwrite it). Fixed
          // structurally: each profile gets its own path via
          // mcpConfigPathFor(..., profile), so concurrent spawns of
          // DIFFERENT profiles for the same agent can never race on one file.
          //
          // Ticket ee26302d review round 3 (P1): pass ctx.workspace_id through
          // here too — omitting it (as round 2 did) collapses workspace A and
          // workspace B onto the SAME unscoped path whenever they share an
          // agent id, so whichever workspace spawns first "wins" the file and
          // the other silently reuses it (wrong Authorization, or a stale
          // auth failure) instead of getting its own workspace-scoped config.
          const profile = toolProfileHeader['X-AWB-Tool-Profile'] === 'compact' ? 'compact' : 'full';
          const profileConfigPath = mcpConfigPathFor(ctx.agent_id, ctx.workspace_id, profile);
          configPath = existsSync(profileConfigPath)
            ? profileConfigPath
            : await writeMcpConfig(
                ctx.agent_id, this.#config.url, effectiveApiKey, ctx.workspace_id, toolProfileHeader,
              );
          configPathIsTemp = false;
        } else {
          configPath = join(
            this.#pidDir,
            `cfg-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
          );
          configPathIsTemp = true;
          await fsp.mkdir(dirname(configPath), { recursive: true, mode: 0o700 });

          const headers: Record<string, string> = {
            Authorization: `Bearer ${effectiveApiKey}`,
            'X-AWB-Client-Type': ctx ? 'managed-subagent' : 'subagent',
            ...toolProfileHeader,
          };
          if (spec.ticketId) headers['X-AWB-Subagent-Ticket-Id'] = spec.ticketId;
          if (spec.role) headers['X-AWB-Subagent-Role'] = spec.role;
          if (attributedSpec.triggerSource) {
            headers['X-AWB-Subagent-Trigger-Source'] = attributedSpec.triggerSource;
          }
          if (spec.triggerId) headers['X-AWB-Subagent-Trigger-Id'] = spec.triggerId;
          headers['X-AWB-Subagent-Session-Id'] = String(reservationId);
          const mcpConfig = {
            mcpServers: {
              awb: {
                type: 'http',
                url: `${this.#config.url.replace(/\/$/, '')}/mcp`,
                headers,
              },
            },
          };
          await fsp.writeFile(configPath, JSON.stringify(mcpConfig), { mode: 0o600 });
        }

        Object.assign(
          descriptor,
          this.#adapterResolver.buildOneshot(adapter.cliType, {
            rolePrompt: spec.rolePrompt || '',
            taskText: spec.taskText,
            mcpConfigPath: configPath,
            cwd: effectiveCwd,
            cliHomeDir: ctx?.cli_home_dir ?? null,
            mcpAttribution: this.#mcpAttribution(attributedSpec, !!ctx, String(reservationId)),
            model: attemptModel,
            harness,
            effort: effortFlag,
            ultracode,
          }).descriptor,
        );
      }
      if (claudeRuntimeProfile?.args?.length) {
        descriptor.args.push(...claudeRuntimeProfile.args);
      }

      // base-session-manager 와 동일 — resolveBinOverride 가 CLI 타입 게이팅과
      // claude 의 runtime-lease 우선순위를 공유한다(ticket ce65cf25).
      const binOverride = resolveBinOverride(
        adapter.cliType,
        this.#config.delegation,
        runtimeLease?.claudeExecutable(),
      );
      const resolvedBin = adapter.resolveBin(binOverride);
      // ST-7 follow-up: inject the per-agent CLI home dir via the
      // adapter-specific env var (CLAUDE_CONFIG_DIR / GEMINI_HOME /
      // CODEX_HOME). When the adapter doesn't have one (custom CLI),
      // this is a no-op and the spawn inherits the manager's env.
      const cliHomeEnvKey = adapter.configDirEnv();
      const cliHomeEnv = cliHomeEnvKey && ctx?.cli_home_dir
        ? { [cliHomeEnvKey]: ctx.cli_home_dir }
        : {};
      // Per-agent credential extras (ANTHROPIC_API_KEY / OPENAI_API_KEY /
      // GEMINI_API_KEY) — populated by the adapter's prepareCliHome on
      // spawn_agent. Empty for subscription-mode and unset agents.
      const credentialEnv = ctx?.extra_env ?? {};
      // Start from inherited env, then strip operator-side auth vars when
      // this agent has its own credential. Without the strip an operator's
      // shell-level ANTHROPIC_API_KEY (or OPENAI_API_KEY / GEMINI_API_KEY /
      // GOOGLE_API_KEY) overrides the per-agent .credentials.json/auth.json
      // the adapter wrote into cli-home, silently bypassing per-agent auth.
      const baseEnv = { ...process.env };
      if (ctx?.credential_provider) {
        const stripped: string[] = [];
        for (const k of adapter.authEnvKeys()) {
          if (k in baseEnv) {
            delete baseEnv[k];
            stripped.push(k);
          }
        }
        if (stripped.length > 0) {
          log(
            `Subagent env strip: agent=${ctx.agent_id.slice(0, 8)} provider=${ctx.credential_provider} ` +
              `removed=${stripped.join(',')} (operator-inherited auth would have overridden per-agent credential)`,
          );
        }
      }
      // raw child_process.spawn 대신 crossSpawn 을 쓴다 — Windows npm `.cmd`/`.bat`
      // shim 을 cmd.exe 로, 인자를 PROPERLY ESCAPED 해 실행하기 위함(ticket
      // e299c6b3). bare spawn() 은 `.cmd` 를 exec 못 해 ENOENT, `shell:true` 는
      // 인자를 escape 없이 이어붙여(DEP0190) codex 의 inline TOML `-c` attribution
      // 인자를 망가뜨린다. 진짜 `.exe`/POSIX 바이너리엔 no-op 래퍼라 claude 경로는
      // 그대로다.
      //
      // Windows 에서 detached 는 windowsHide 와 호환되지 않는다: detached: true 가
      // win32 에서 켜는 DETACHED_PROCESS 는 CREATE_NO_WINDOW 와 상호배타적이라,
      // cmd.exe shim 래퍼가 AllocConsole() 을 호출해 콘솔이 잠깐 번쩍인다. Windows
      // 자식은 기본적으로 부모보다 오래 사니 detached 는 이득이 없다. POSIX 에서만
      // 켜서 자식을 새 프로세스 그룹에 두고 터미널 SIGHUP 으로부터 보호한다.
      const child = crossSpawn(resolvedBin, descriptor.args, {
        stdio: descriptor.stdio || ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
        cwd: claudeRuntimeProfile?.cwd || effectiveCwd,
        // harnessEnv merges LAST: a per-dispatch harness model must beat the
        // per-agent extra_env baked at spawn_agent time (deepseek's
        // ANTHROPIC_MODEL — flag/env agreement, see DeepSeekCliAdapter).
        env: resolveClaudeExecutionEffort(slice, claudeRuntimeProfile, {
          ...baseEnv,
          // Board env_vars (ticket 354d336b) merge right after baseEnv so they
          // set non-secret config but never shadow AWB_API_KEY / cli-home /
          // per-agent credential / harness env layered on top.
          ...(spec.envVars ?? {}),
          AWB_API_KEY: effectiveApiKey,
          ...cliHomeEnv,
          ...credentialEnv,
          ...adapter.harnessEnv(harness),
          ...(runtimeLease?.claudeEnv() ?? {}),
          ...(maxOutputResolution?.env ?? {}),
        }).env,
      });
      if (runtimeLease) child.once('close', () => void runtimeLease?.close());
      child.once('error', (err: any) => {
        log(
          `Subagent spawn error: code=${err?.code || ''} cli=${adapter.cliType} bin=${resolvedBin} msg=${err?.message}`,
        );
        // 실패를 AWB 대시보드에 노출한다(ticket e299c6b3) — 실행 못 하는 CLI
        // (예: 해소 안 된 Windows shim 의 codex ENOENT)가 5분마다 조용히 루프
        // 도는 걸 멈추게 한다.
        spawnFailureTracker.record({
          cli: adapter.cliType,
          code: err?.code,
          message: err?.message ?? String(err),
        });
      });
      child.unref();

      const pid = child.pid;
      if (!pid) {
        // Only unlink a per-spawn TEMP config. Reused static per-agent
        // mcp-config.json (configPathIsTemp=false) is shared across every
        // spawn for the agent — deleting it here on a no-pid spawn failure
        // is what left agents with a missing mcp-config.json, breaking all
        // later chat/subagent sessions ("MCP config file not found").
        // Mirrors the catch (line ~694) and exit-handler (line ~709) guards.
        if (configPath && configPathIsTemp) await fsp.unlink(configPath).catch(() => {});
        this.#map.delete(reservationId);
        return { spawned: false, reason: 'spawn_failed' };
      }

      // 살아있는 pid 는 CLI 가 떴다는 뜻 — 다음 heartbeat 에서 이 CLI 의 이전
      // spawn-failure 배지를 지운다(ticket e299c6b3).
      spawnFailureTracker.recordSuccess(adapter.cliType);

      if (typeof descriptor.writePrompt === 'function') {
        try {
          descriptor.writePrompt(child);
        } catch (err: any) {
          log(`Subagent writePrompt failed: ${err?.message ?? err}`);
        }
      }

      const record: SubagentRecord = {
        pid,
        kind: spec.kind,
        cli_type: adapter.cliType,
        trigger_id: spec.triggerId || null,
        audit_session_id: String(reservationId),
        mention_audit_run_token: mentionAudit?.run_token,
        silent_exit_attempt: mentionAudit ? (spec._silentExitAttempt ?? 0) : undefined,
        chat_request_id: spec.chatRequestId || null,
        ticket_id: spec.ticketId || null,
        agent_id: spec.agentId || null,
        role: spec.role || null,
        room_id: spec.roomId || null,
        started_at: Date.now(),
        expected_completion_at:
          Date.now() + (spec.ttlMinutes ?? this.#config.delegation.ttlMinutes ?? 15) * 60_000,
        config_path: configPath,
        config_path_is_temp: configPathIsTemp,
        process_handle: child,
        captureOutput: !adapter.has(NATIVE_MCP),
        outLines: [],
        tailLines: [],
        commentSent: false,
        tap: null,
        usage: null,
        modelChain,
        chainAttempt,
        respawnSpec: spec,
        onSpawnExit: spec.onExit,
        run: spec.run ?? null,
      };
      record.tap =
        this.#monitor?.register({
          kind: 'oneshot',
          sessionKey: spec.triggerId
            ? `oneshot:trigger:${spec.triggerId}`
            : spec.chatRequestId
              ? `oneshot:chat:${spec.chatRequestId}`
              : `oneshot:${pid}`,
          pid,
          // Same per-agent attribution as BaseSessionManager._spawnSession:
          // when a managed-agent context is in play, the subagent should be
          // owned by the managed agent on the server's subagent list.
          apiKey: ctx?.api_key,
        }) || null;
      this.#map.delete(reservationId);
      this.#map.set(pid, record);
      this.#persist();

      this.#wireExitHandler(child, pid);
      this.#wireStdioCapture(child, pid);

      log(
        `Subagent spawned: pid=${pid} cli=${adapter.cliType} kind=${spec.kind} ticket=${spec.ticketId || '-'}`,
      );
      return { spawned: true, pid };
    } catch (err: any) {
      this.#map.delete(reservationId);
      if (configPath && configPathIsTemp) {
        await fsp.unlink(configPath).catch(() => {});
      }
      await runtimeLease?.close();
      log(`Subagent spawn error: ${err?.message ?? err}`);
      // ticket da4358ee: classify BEFORE collapsing into the generic bucket —
      // a codex InvalidMcpTransportError (thrown by buildOneshotSpawn's
      // pre-spawn config validation) is a deterministic config error that
      // reproduces identically on every retry. Preserving that here lets the
      // caller route it through the durable-blocker pend path instead of the
      // ordinary cooldown-backoff retry that let it retry-storm for ~2 days.
      const { reason, detail, serverKey } = classifySpawnException(err);
      return { spawned: false, reason, detail, serverKey };
    }
  }

  #mcpAttribution(spec: SubagentSpawnArgs, managed: boolean, sessionId: string) {
    if (!spec.ticketId && !spec.role && !spec.triggerSource && !spec.triggerId) return undefined;
    return {
      clientType: managed ? 'managed-subagent' as const : 'subagent' as const,
      ticketId: spec.ticketId || undefined,
      role: spec.role || undefined,
      triggerSource: spec.triggerSource || undefined,
      triggerId: spec.triggerId || undefined,
      sessionId,
    };
  }

  #wireExitHandler(child: ChildProcess, pid: number): void {
    // Capture the run-lifetime lock release NOW (ticket e9d0e8bc). A kill /
    // reaper path can force-drop this record from #map before the exit fires,
    // which would make the lookup below early-return and leak the lock — so hold
    // the release in the closure and fire it on ANY exit. The callback is
    // idempotent (FolderMutex release), so a double-fire is harmless.
    const rec0 = this.#map.get(pid);
    const onSpawnExit = rec0 && rec0.kind !== 'reservation' ? rec0.onSpawnExit : undefined;
    // `exit` may precede the final stdout/stderr `data` callbacks. `close`
    // runs after both streams drain, so this spawn's comment scanner has
    // consumed its final MCP event before silent-exit accounting begins.
    child.once('close', async (code, signal) => {
      if (onSpawnExit) {
        try {
          onSpawnExit();
        } catch {
          /* ignore — lock release must never break exit cleanup */
        }
      }
      // Chat-progress state is per-pid; drop it on ANY exit, including the
      // drop-first kill paths (restart_agent / stopForAgent / TTL #sweep) that
      // remove the record first and make the lookup below early-return.
      this.#progressMeta.delete(pid);
      const record = this.#map.get(pid);
      if (!record || record.kind === 'reservation') return;
      const durationSec = Math.round((Date.now() - record.started_at) / 1000);
      this.#map.delete(pid);
      this.#persist();
      if (record.config_path && record.config_path_is_temp) {
        try {
          await fsp.unlink(record.config_path);
        } catch {
          /* best-effort */
        }
      }
      // Model attribution rides on `usage` only when we also have real numeric
      // usage to report — an all-null usage object solely to carry a model
      // string isn't worth the wire noise (ticket 6dd3f968).
      const resolvedModel = record.modelChain?.[record.chainAttempt ?? 0] ?? null;
      record.tap?.end({
        exit_code: code,
        signal,
        usage: record.usage ? { ...record.usage, model: resolvedModel } : undefined,
      });

      // Answer-posting, circuit-breaker and silent-exit fallback. Extracted to
      // a named method so it can be unit-tested without forking a real child.
      await this._handleOneshotExit(record, code);

      // ticket 55d3063f: if this was a QA/security run one-shot, sweep the turn
      // end for orphaned background tasks the CLI left running and finalize a
      // stranded run as `error`. Gated on record.run so ordinary spawns skip the
      // process enumeration entirely. Guarded internally — never throws.
      //
      // ticket 6abe2b79 리뷰 라운드3: 아래 두 단계가 쓰던 `record.run` 을 여기서
      // #claimRun 으로 딱 한 번, 동기적으로 떼어낸다 — stop() 의 force-kill
      // fallback 도 동일한 메서드로 claim 하므로, 둘 중 먼저 이 동기 구간을
      // 통과하는 쪽만 이 run 을 완료 처리한다. 이후 두 단계는 이 로컬 스냅샷만
      // 쓰고 record.run 을 다시 읽지 않는다.
      const claimedRun = this.#claimRun(record);
      if (claimedRun) {
        const finalizedByOrphanSweep = await this._sweepOneshotRunOrphans(record, claimedRun);
        // ticket 152e3606: run-completion backstop — 같은 티켓으로 고친
        // ChatSessionManager#_onChildExit의 oneshot 짝. orphan sweep 이 이미
        // 끝내지 않았을 때만 필요한 이유는 _runExitCompletionBackstop 자체
        // docstring 참고. 내부에서 가드하므로 절대 throw하지 않는다.
        if (!finalizedByOrphanSweep) {
          await this._runExitCompletionBackstop(record, code, claimedRun);
        }
      }

      // ticket 6abe2b79: 이 victim 의 post-exit 체인(위 run-completion backstop
      // 포함)이 실제로 끝났음을 대기 중인 stop() 에 알린다 — stop() 이 SIGKILL
      // 직후 바로 반환하지 않고 실제 완료를 기다릴 수 있게 한다. stop() 밖에서는
      // #stopWaiters 가 비어 있으므로 no-op.
      const stopWaiter = this.#stopWaiters.get(pid);
      if (stopWaiter) {
        this.#stopWaiters.delete(pid);
        stopWaiter();
      }

      // Drop the tail ring now that all post-exit hooks have read it.
      record.tailLines = [];

      log(
        `Subagent exit: pid=${pid} cli=${record.cli_type || '-'} kind=${record.kind} code=${code} signal=${signal || '-'} duration=${durationSec}s`,
      );
      if (typeof this.onExit === 'function') {
        try {
          this.onExit({ pid, record, code, signal, durationSec });
        } catch {
          /* ignore */
        }
      }
    });
    child.once('error', (err: any) => {
      log(`Subagent spawn error pid=${pid}: ${err?.message ?? err}`);
    });
  }

  /**
   * Post-exit business logic for a one-shot subagent: answer aggregation,
   * circuit-breaker accounting, and the silent-exit fallback. Split out of the
   * `exit` closure so it is unit-testable (the closure keeps the process
   * lifecycle bits — map cleanup, persist, temp-config unlink, tap.end). Public
   * (`_`-prefixed) for the test runner; not part of the manager contract.
   */
  async _handleOneshotExit(record: SubagentRecord, code: number | null): Promise<void> {
    const pid = record.pid;

    // ticket 6abe2b79: stop() 가 이제 시그널 전에 #map 에서 지우는 대신 모든
    // victim 에 stopReason 을 태그하므로, 매니저 shutdown 킬도 #wireExitHandler
    // 의 #map 조회에서 early-return 되지 않고 여기까지 들어온다. 아래 로직은
    // 우리가 방금 직접 죽인 프로세스에는 전혀 맞지 않는다 — 집계할 실제 답변도
    // 없고, model-fallback 재-spawn 도 의미 없으며(매니저가 종료 중이므로),
    // mention-audit 재시도도 안 되고, 무엇보다 circuit-breaker 페널티는 절대
    // 안 된다. #sweep/stopForAgent 가 drop-first 로 지켜온 "reap 은 배달
    // 실패가 아니다" 보장을 stop() 에도 그대로 확장하되, drop-first 의 부작용
    // (run-completion backstop 이 아예 안 도는 것)은 재도입하지 않는다. 그
    // backstop 은 여전히 실행된다 — #wireExitHandler 에서 record.run 이 있으면
    // 무조건 — summary 에 추측 대신 stopReason 이 반영된 채로.
    if (record.stopReason) {
      log(`Subagent exit pid=${pid} skip: manager-initiated stop (reason=${record.stopReason})`);
      return;
    }

    // Classification of the aggregated one-shot result. Defaults to non-fatal;
    // only set for non-NATIVE_MCP adapters (codex / antigravity) whose stdout
    // we collect. Read below by both the answer-posting guard and the
    // circuit-breaker to decide non-retryable failures.
    let errClass = classifyCliError(null);

    if (record.captureOutput && (record.ticket_id || record.room_id)) {
      try {
        // Use the same adapter that spawned this child — picked by
        // record.cli_type so we don't aggregate antigravity's stdout with
        // claude's parser.
        let answer = this.#adapterFor(record.cli_type).collectOneshotResult(record.outLines);
        // Pass the exit code so usage/auth signatures are only fatal in a real
        // error context — a clean exit-0 answer that merely mentions 403/429/
        // quota stays a valid agent answer (won't be suppressed or trip the
        // breaker). codex's own [codex error] wrapper also counts as context.
        errClass = classifyCliError(answer, { exitCode: code });
        if (record.room_id) {
          // Chat one-shot: post the result (or a generic failure) to the room.
          // Chat replies don't feed the ticket trigger loop, so the re-trigger
          // guard below is irrelevant here — keep prior behavior.
          const ordinaryFallback = answer ? parseOrdinaryWorkFallback(answer) : null;
          const fallback = answer ? parseOperationalFallback(answer) : null;
          if (ordinaryFallback) {
            try {
              const ticket = await ensureOrdinaryWorkFallbackTicket(this.#config, ordinaryFallback, {
                room_id: record.room_id,
                message_id: record.chat_request_id || '',
              });
              answer = `${ticket.reused ? '기존' : '새'} 작업 티켓을 ${ticket.reused ? '재사용' : '자동 생성'}하고 워크플로에 연결했습니다: ${ticket.id} ${ticket.title}`;
            } catch (error: any) {
              log(`[ordinary-work-fallback] observable failure room=${record.room_id}: ${error?.message || error}`);
              answer = `⚠️ 작업 티켓 자동 생성에 실패했습니다. 채팅 답변만으로 완료 처리하지 않고 매니저 오류로 기록했습니다: ${error?.message || error}`;
            }
          } else if (fallback) {
            try {
              const ticket = await ensureOperationalFallbackTicket(this.#config, fallback, {
                room_id: record.room_id,
                message_id: record.chat_request_id || '',
              });
              answer = `${ticket.reused ? '기존' : '새'} capability 티켓을 ${ticket.reused ? '재사용' : '자동 생성'}했습니다: ${ticket.id} ${ticket.title}`;
            } catch (error: any) {
              log(`[operational-fallback] observable failure room=${record.room_id}: ${error?.message || error}`);
              answer = `⚠️ 운영 capability 자동 티켓 생성에 실패했습니다. 사용자 작업을 요청하지 않고 매니저 오류로 기록했습니다: ${error?.message || error}`;
            }
          }
          if (answer) {
            await this.#postOneshotChatAnswer(record, answer);
          } else if (code !== 0) {
            await this.#postOneshotChatAnswer(
              record,
              `⚠️ Agent가 응답하지 못했습니다 (exit code ${code ?? 'unknown'}).`,
            );
          }
        } else if (answer) {
          // Ticket one-shot (defect ①): post under the AGENT identity ONLY for
          // a clean, non-error result. A non-zero exit or a CLI fatal-error
          // signature (codex `[codex error]` / usage-limit / auth) is NOT a
          // real answer — posting it as an agent comment re-fires the trigger
          // loop (the comment.created passes the server's system-actor guard).
          // Suppress it and let the system-attributed silent-exit fallback
          // below post instead, which the server trigger-loop guard drops.
          if (code === 0 && !errClass.isFatal) {
            await this.#postOneshotAnswer(record, answer);
          } else {
            log(
              `Subagent one-shot result NOT posted as agent answer: ticket=${(record.ticket_id || '').slice(0, 8)} ` +
                `cli=${record.cli_type} code=${code} reason=${errClass.reason || (code !== 0 ? `nonzero_exit_${code}` : 'unknown')} ` +
                `— routing to system silent-exit fallback`,
            );
          }
        }
      } catch (err: any) {
        log(`Subagent post-answer failed pid=${pid}: ${err?.message ?? err}`);
      }
    }

    // 폴백 모델 체인 (ticket 61f4dd18). 주 모델이 폴백-적격 실패(usage cap /
    // model unavailable)로 죽었고, 이번 시도가 산출물(commentSent)을 전혀 남기지
    // 못했으며, 체인에 남은 모델이 있으면 다음 모델로 재-spawn 한다. 서킷브레이커/
    // silent-exit 앞에 두어, 폴백이 성공적으로 시작되면 이번 사망을 실패로 세지
    // 않고 조용히 넘긴다(early return). 체인이 소진된 마지막 시도만 아래의
    // 브레이커/silent-exit 경로로 떨어진다. commentSent 가드 + 적격 사유 + 체인
    // 길이 상한이 무한 폴백(scope ④)을 막는다.
    if (
      record.kind === 'trigger' &&
      record.ticket_id &&
      !record.commentSent &&
      isFallbackEligible(errClass) &&
      record.respawnSpec &&
      Array.isArray(record.modelChain) &&
      (record.chainAttempt ?? 0) + 1 < record.modelChain.length
    ) {
      const nextAttempt = (record.chainAttempt ?? 0) + 1;
      const prevModel = record.modelChain[record.chainAttempt ?? 0];
      const nextModel = record.modelChain[nextAttempt];
      log(
        `[subagent] model fallback: ticket=${record.ticket_id.slice(0, 8)} role=${record.role || '_'} ` +
          `reason=${errClass.reason} ${prevModel ?? '(default)'} → ${nextModel ?? '(default)'} ` +
          `(attempt ${nextAttempt + 1}/${record.modelChain.length})`,
      );
      try {
        const res = await this.spawn({
          ...record.respawnSpec,
          _modelChain: record.modelChain,
          _chainAttempt: nextAttempt,
        });
        // 다음 모델 spawn 이 실제로 떴을 때만 이번 사망을 폴백으로 흡수한다.
        // 못 떴으면(브레이커 open / 중복 / spawn 실패) 아래로 떨어져 정상적인
        // 브레이커/silent-exit 경로가 이 티켓을 처리하게 둔다.
        if (res.spawned) return;
        log(
          `[subagent] model fallback respawn not started (reason=${res.reason ?? 'unknown'}) — ` +
            `falling through to breaker/silent-exit`,
        );
      } catch (err: any) {
        log(`[subagent] model fallback respawn threw: ${err?.message ?? err} — falling through`);
      }
    }

    // ticket 467f714a: a harness session-limit death (`You've hit your session
    // limit · resets …`) is time-healed at a concrete reset — defer the agent's
    // dispatch until then rather than force-opening the breaker (which the
    // session_limit classification would otherwise do via nonRetryable, pending on
    // the FIRST death) or model-fallback (same account still hits the wall).
    // Detected off the raw tail so it covers a claude one-shot whose answer we
    // don't capture (NATIVE_MCP); if the tail can't be parsed but the aggregated
    // answer already classified session_limit, a conservative default window is
    // used. Mirrors TicketSessionManager._onChildExit.
    const oneshotTail =
      record.kind === 'trigger' && record.ticket_id ? this.#collectTail(record) : '';
    let harnessSessionLimit: HarnessSessionLimitDetection | null = null;
    if (record.kind === 'trigger' && record.ticket_id && record.agent_id && !record.commentSent) {
      harnessSessionLimit =
        detectHarnessSessionLimit(oneshotTail, code, Date.now()) ??
        (errClass.reason === 'session_limit'
          ? { reason: 'session_limit', resetLabel: '', deferUntilMs: resolveDeferUntil(Date.now(), null) }
          : null);
      if (harnessSessionLimit && this.onHarnessSessionLimit) {
        log(
          `[subagent] harness session-limit exit ticket=${record.ticket_id.slice(0, 8)} ` +
            `role=${record.role || '_'} agent=${record.agent_id.slice(0, 8)} ` +
            `reset="${harnessSessionLimit.resetLabel || '(unparsed → default window)'}" — deferring dispatch`,
        );
        try {
          this.onHarnessSessionLimit({
            agentId: record.agent_id,
            ticketId: record.ticket_id,
            role: record.role || '',
            reason: harnessSessionLimit.reason,
            resetLabel: harnessSessionLimit.resetLabel,
            deferUntilMs: harnessSessionLimit.deferUntilMs,
          });
        } catch (err: any) {
          log(`[subagent] onHarnessSessionLimit hook threw: ${err?.message ?? err}`);
        }
      }
    }

    if (record.kind === 'trigger' && record.ticket_id && !record.commentSent) {
      if (code === 0 && record.mention_audit_run_token && record.respawnSpec) {
        const audit = await completeMentionAuditRun(
          this.#config,
          record.ticket_id,
          record.mention_audit_run_token,
          code,
        );
        if (audit?.decision === 'succeeded') {
          record.commentSent = true;
          if (record.agent_id) {
            this.circuitBreaker.recordSuccess(
              CircuitBreaker.key(record.agent_id, record.ticket_id, record.role || ''),
            );
          }
          return;
        }
        if (audit?.decision === 'retry') {
          const retry = await this.spawn({
            ...record.respawnSpec,
            _silentExitAttempt: 1,
          });
          if (retry.spawned) {
            log(
              `[subagent] clean mention silent-exit retry started ticket=${record.ticket_id.slice(0, 8)} ` +
                `trigger=${(record.trigger_id || '').slice(0, 24)}`,
            );
            return;
          }
          log(
            `[subagent] clean mention silent-exit retry spawn failed ticket=${record.ticket_id.slice(0, 8)} ` +
              `reason=${retry.reason || 'unknown'} — recording terminal fallback`,
          );
          const terminal = await failMentionAuditRetrySpawn(
            this.#config,
            record.ticket_id,
            record.mention_audit_run_token,
          );
          record.silent_exit_attempt = 1;
          record.silent_exit_terminal_reason =
            terminal?.reason || 'silent_exit_retry_spawn_failed';
          record.silent_exit_family_key = terminal?.family_key;
        } else if (audit?.decision === 'retry_claimed') {
          return;
        }
      }
      const auditOutcome = await this.#postSilentExitFallback(record, code);
      if (auditOutcome === 'suppressed') {
        record.commentSent = true;
        if (record.agent_id) {
          this.circuitBreaker.recordSuccess(
            CircuitBreaker.key(record.agent_id, record.ticket_id, record.role || ''),
          );
        }
        return;
      }
    }

    // Circuit-breaker (ticket 27806095, defect ②/③). Ticket triggers only —
    // count non-transient exits per (agent, ticket, role); open + pend when the
    // threshold is crossed, OR immediately for a non-retryable signature
    // (usage-limit / auth). A clean exit that left a real agent comment resets
    // the counter. A harness session-limit death is handled above (defer, not
    // pend), so it skips the breaker entirely. Mirrors TicketSessionManager.
    if (!harnessSessionLimit && record.kind === 'trigger' && record.ticket_id && record.agent_id) {
      const role = record.role || '';
      const cbKey = CircuitBreaker.key(record.agent_id, record.ticket_id, role);
      // ticket 7e7e23bf: a subagent that surfaced an audit-trail comment did
      // real work; a post-hoc non-zero exit is NOT a failure to count. Record
      // the success even on a non-zero exit — UNLESS the tail carries a
      // non-retryable fatal signature (usage-limit / auth), where the immediate
      // pend still protects against burning respawns on a hard external block
      // (ticket ac958c06). recordSuccess() (not reset()) so an already-OPEN
      // breaker stays open for a human/operator to close (ticket b2e88390) —
      // it only fully clears a streak that hadn't tripped yet.
      if (record.commentSent && !errClass.nonRetryable) {
        this.circuitBreaker.recordSuccess(cbKey);
      } else if (
        !record.commentSent ||
        !CircuitBreaker.isTransientExit(code) ||
        errClass.nonRetryable
      ) {
        // A SILENT exit (no comment-tool trace) is a failure to deliver even
        // when `code` looks "transient". A one-shot that dies by signal
        // (code === null) or a benign numeric signal code, yet left ZERO ticket
        // activity, is exactly the respawn-storm signature (ticket c555fbb6 /
        // benchmark ticket 2c2c4eb1: antigravity exit_code=null, "no buffered
        // CLI output", supervisor re-triggered ~2755×). Those never reached the
        // breaker because isTransientExit(null) === true, so the ticket never
        // pended and the loop ran forever. Count silent exits regardless of
        // `code`: a real comment still takes the reset branch above, and the
        // manager-initiated reaps that drop the record from #map BEFORE the exit
        // handler runs — restart_agent / stopForAgent AND the TTL idle-timeout
        // #sweep, all drop-first — never reach here at all (see #wireExitHandler's
        // `if (!record) return`), so a `null` code reaching here is an unexpected
        // death, not one of those benign reaps. A genuine one-off transient kill
        // is followed by a successful run that resets the counter, so only a
        // persistent silent-exit loop pends.
        const tail = oneshotTail || this.#collectTail(record);
        const { justOpened, entry } = this.circuitBreaker.record(cbKey, code, tail, {
          forceOpen: errClass.nonRetryable,
        });
        if (justOpened) {
          const exitDesc = errClass.reason
            ? errClass.reason
            : code === 0
              ? 'clean exit with no comment'
              : `exit code ${code}`;
          const reason =
            `Agent failed ${entry.consecutiveFailures} consecutive time(s) (${exitDesc}). ` +
            `Last output: ${entry.lastExitTail || '(none)'}. ` +
            `Check agent CLI config/credentials and unpend when fixed.`;
          // Await so the loop-terminating pend completes before the exit
          // handler returns (deterministic ordering; fireAndForgetTool already
          // swallows its own errors so a pend failure can't break cleanup).
          await fireAndForgetTool(this.#config, 'pend_ticket', {
            ticket_id: record.ticket_id,
            reason,
          });
        }
      }
    }

    // Silent-exit fallback for ticket subagents. Fires ONLY when the subagent
    // left NO comment-creating tool trace during the spawn — the "dead state"
    // the ticket was opened against (trigger dispatched but ticket activity has
    // zero trace of work), whether the exit was clean or non-zero.
    //
    // A subagent that DID surface a comment and then exited non-zero is a
    // post-hoc crash, not a silent exit (ticket 7e7e23bf) — the deliverable is
    // already persisted, so the "exited without leaving a ticket comment"
    // warning would be a false positive. Suppress it (log only).
    //
    // Chat-only spawns (room_id but no ticket_id) are already covered by the
    // room_id branch above and by ChatSessionManager's fallback, so we skip
    // them here. This system-attributed comment is what the server trigger-loop
    // guard drops, so it never re-fires the loop.
    if (record.ticket_id && record.commentSent && code !== 0) {
      log(
        `Subagent post-comment exit (exit=${code ?? 'null'}) — deliverable already persisted, ` +
          `suppressing silent-exit fallback ticket=${record.ticket_id.slice(0, 8)}`,
      );
    }
  }

  /**
   * Turn-end orphan sweep for a one-shot QA/security run (ticket 55d3063f) —
   * the non-persistent twin of ChatSessionManager#sweepTurnEndOrphans. Fired
   * from the exit handler when `record.run` is set. The one-shot CLI self-exits
   * at turn end with NO pre-kill window, so — unlike the persistent path, which
   * sweeps ~4s later while the CLI is still alive — we enumerate the child's
   * POSIX process GROUP (the child was spawned detached, so pgid == pid) instead
   * of ppid-walking from the now-dead pid: a background task reparented to init
   * when the CLI exited still carries the group id, whereas a ppid walk from the
   * dead pid would find nothing. If live non-benign tasks remain, they are ones
   * the run left running with no re-invocation contract — reap them visibly and
   * finalize the run as `error` (recording the kill in the summary + manager
   * log) instead of letting the ~45-min liveness reaper find the `running`
   * zombie. Re-reads run status first so a run the agent already finalized is
   * never clobbered. Every await is guarded — this runs inside the exit closure
   * and must never reject. Public (`_`-prefixed) for the test runner.
   *
   * ticket 6abe2b79 리뷰 라운드3: `runOverride` 가 주어지면(closure 가 #claimRun
   * 으로 이미 떼어낸 스냅샷) 그걸 쓰고, 없으면(기존 직접-호출 유닛 테스트 호환)
   * `record.run` 을 그대로 읽는다. 반환값 `true` 는 "이 run 은 여기서 완료
   * 처리됐거나 이미 terminal 이라 더 손댈 게 없다" — 호출자(closure)는 이 경우
   * `_runExitCompletionBackstop` 을 또 부르면 안 된다.
   */
  async _sweepOneshotRunOrphans(
    record: SubagentRecord,
    runOverride?: RunSessionBinding | null,
  ): Promise<boolean> {
    const run = runOverride !== undefined ? runOverride : record.run;
    if (!run) return false;

    let orphans: ProcNode[];
    try {
      orphans = await findLiveGroupBackgroundTasks(record.pid);
    } catch (err: any) {
      log(`[subagent] run orphan sweep enumeration failed pid=${record.pid}: ${err?.message ?? err}`);
      return false;
    }
    if (orphans.length === 0) return false; // clean one-shot turn — nothing stranded

    const run8 = run.run_id.slice(0, 8);
    const pidList = orphans.map((o) => o.pid).join(',');

    // Never overwrite a run the agent already finalized. Availability-first: an
    // unreadable status is treated as non-terminal so a transient server hiccup
    // 트랩을 놓치는 일이 없게 한다. ticket 9fd27487: 'action' 은 getTool 이
    // null 이므로(get_action_run tool 이 없음) 항상 아래 reap 경로로 빠진다 —
    // complete_action_run 의 terminal 전이는 멱등이라 안전하다(이미 terminal 인
    // run 에 걸리는 stray finalize 는 no-op).
    const route = resolveRunCompletionRoute(run.kind);
    let status: string | null = null;
    if (route.getTool) {
      try {
        const resp = await callMcpTool(this.#config, route.getTool, {
          run_id: run.run_id,
          workspace_id: run.workspace_id,
        });
        const rec = unwrapToolResult(resp);
        if (rec && typeof rec.status === 'string') status = rec.status;
      } catch (err: any) {
        log(`[subagent] run orphan sweep status read failed run=${run8}: ${err?.message ?? err}`);
      }
    }
    if (status === 'passed' || status === 'failed' || status === 'error') {
      // Run already finalized — the strays are the agent's own leftovers, not a
      // stranded run. Log for forensics but don't reap (avoid clobbering a
      // benign helper an exclusion gap missed) or overwrite the summary.
      log(
        `[subagent] run ${run8} already ${status}; ${orphans.length} live background task(s) present ` +
          `at oneshot cleanup [pids=${pidList}] — leaving to normal teardown`,
      );
      return true; // 이미 terminal — backstop 이 또 부를 필요 없음
    }

    // THE TRAP: one-shot run exited its turn with live non-benign descendants and
    // is still non-terminal. Reap them visibly + finalize the run as error.
    let reaped: number[] = [];
    try {
      reaped = await reapProcessTrees(orphans.map((o) => o.pid));
    } catch (err: any) {
      log(`[subagent] run orphan reap failed run=${run8}: ${err?.message ?? err}`);
    }
    const detail = orphans
      .slice(0, ORPHAN_SUMMARY_MAX_DETAIL)
      .map((o) => `pid=${o.pid} ${o.cmd.slice(0, 80)}`)
      .join('; ');
    const summary =
      `session cleanup killed ${orphans.length} live background task(s) — ` +
      `원샷 run 세션이 재호출 계약 없이 살아있는 백그라운드 태스크를 남긴 채 턴을 종료했습니다. ` +
      `reaped pids: ${pidList}. ${detail}`;
    await fireAndForgetTool(this.#config, route.completeTool, {
      run_id: run.run_id,
      workspace_id: run.workspace_id,
      status: route.failureStatus,
      summary,
    });
    record.run = null; // finalized — belt-and-suspenders against a double sweep
    log(
      `[subagent] run ${run8} oneshot cleanup: reaped ${reaped.length}/${orphans.length} ` +
        `live background task(s) [pids=${pidList}] — finalized run as error`,
    );
    return true;
  }

  /**
   * Run-completion backstop(ticket 152e3606) — 같은 티켓으로 고친
   * ChatSessionManager#_onChildExit의 oneshot 짝. 위 `_sweepOneshotRunOrphans`는 LIVE
   * ORPHAN 프로세스를 찾았을 때만 run을 종료 처리한다 — orphan이 하나도 없이
   * 멈춘 run(예: 아무도 승인해줄 수 없는 permission 승인 대기에 걸려서 승인
   * 대상 도구조차 시작 못 한 경우)은 거기서 일찍 return돼 `record.run`이
   * 그대로 남는다. 이게 없으면 로컬 프로세스가 이미 죽었는데도(TTL sweep /
   * kill / crash — 어떤 exit이든 결국 호출자인 `#wireExitHandler`의 `close`
   * 콜백으로 모인다) run은 서버에서 영원히 `running`으로 남는다. 무조건 +
   * fire-and-forget: complete_*_run의 terminal 전이는 원자적으로
   * 멱등이라(actions.service.ts의 completeRun, `status = 'running'` 가드)
   * 에이전트 자신이 이미 종료 처리했거나 호출자에서 방금 전 orphan sweep이
   * 처리한 run은 그대로 유지된다. 절대 throw하지 않는다 — 모든 실패는
   * fireAndForgetTool 자체의 내부 catch로 흡수된다. 테스트 러너를 위해
   * `#private`가 아니라 `_` 접두사로 뒀다.
   *
   * ticket 6abe2b79 리뷰 라운드3: `runOverride` 가 주어지면(closure/stop() 이
   * #claimRun 으로 이미 떼어낸 스냅샷) 그걸 쓰고, 없으면(기존 직접-호출 유닛
   * 테스트 호환) `record.run` 을 읽는다.
   */
  async _runExitCompletionBackstop(
    record: SubagentRecord,
    code: number | null,
    runOverride?: RunSessionBinding | null,
  ): Promise<void> {
    const run = runOverride !== undefined ? runOverride : record.run;
    if (!run) return;
    const route = resolveRunCompletionRoute(run.kind);
    // ticket 152e3606 요구사항 2: CLI 자체의 untrusted-workspace 경고를
    // (그냥 두면 아무도 안 읽는 stdout 속에 묻힌다) 진단 가능한 원인일 때
    // run의 실패 summary로 승격한다 — 구체적이고 실행 가능한 메시지가 그냥
    // "결과 없음" 보다 낫다.
    const tail = this.#collectTail(record);
    // ticket 6abe2b79: stop() 이 이제 SIGTERM 전에 #map 을 비우는 대신 모든
    // victim 에 stopReason 을 태그해 두므로(레코드는 exit 핸들러가 정리),
    // 매니저 shutdown 킬도 여기까지 정상적으로 들어온다 — ticket b831b896
    // round 3 의 "manager-initiated kill 은 절대 이 backstop 에 못 닿는다"는
    // 전제는 더 이상 사실이 아니다. stopReason 이 있으면 그 정확한 사유를
    // 그대로 보고하고(untrusted-workspace 탐지나 "TTL sweep/kill 때문일 수
    // 있다"는 추측은 둘 다 이 케이스엔 안 맞고, 후자는 이 티켓이 없애려는 바로
    // 그 추측성 문구다), stopReason 이 없을 때만(=진짜 원인불명 — crash, 승인
    // 대기 등) b831b896 round 3 이 정리한 정직한 "reason=unknown" 문구로
    // 폴백한다.
    const summary = record.stopReason
      ? `agent-manager가 프로세스를 종료해 이 run이 결과 없이 중단됐습니다 (reason=${record.stopReason}).`
      : hasUntrustedWorkspaceWarning(tail)
        ? 'run 세션이 CLI workspace trust 미승인으로 종료됐습니다 — .claude/settings.json의 ' +
          'permissions.allow가 무시되어 비대화형 세션이 진행하지 못했습니다. 해당 agent ' +
          'cli-home의 .claude.json trust 시딩을 확인하세요.'
        : `run 세션 프로세스가 결과 없이 종료됐습니다(exit code=${code ?? 'null'}, reason=unknown) — ` +
          `종료를 유발한 매니저 측 동작이 관측되지 않았습니다.`;
    await fireAndForgetTool(this.#config, route.completeTool, {
      run_id: run.run_id,
      workspace_id: run.workspace_id,
      status: route.failureStatus,
      summary,
    });
    // ticket 6abe2b79 리뷰 라운드3: 호출자가 대부분 #claimRun 으로 이미 null
    // 처리해 둔 상태라 대개 no-op 이지만, override 없이 직접 불린 경우(기존
    // 유닛 테스트)에도 이중 호출을 막는 belt-and-suspenders.
    record.run = null;
  }

  #wireStdioCapture(child: ChildProcess, pid: number): void {
    // ST-6 follow-up: prefix log lines with the managed agent's short id when
    // we know one. Multi-tenant manager hosts spawn children for many agents
    // through a shared log stream, so without this you can't tell which
    // agent's subagent printed what. Falls back to bare `[subagent:<pid>]`
    // for the legacy single-agent case where agent_id is not set on the spawn
    // record.
    const tagFor = (record: SubagentRecord | undefined): string => {
      if (record && record.agent_id) {
        return `[subagent:${pid}][agent:${record.agent_id.slice(0, 8)}]`;
      }
      return `[subagent:${pid}]`;
    };

    if (child.stdout) {
      const rlOut = createInterface({ input: child.stdout });
      rlOut.on('line', (line) => {
        const rec = this.#map.get(pid);
        const record = rec && rec.kind !== 'reservation' ? (rec as SubagentRecord) : undefined;
        if (record) {
          record.tap?.outLine(line);
          if (record.captureOutput) {
            if (record.outLines.length < 10000) record.outLines.push(line);
          }
          this.#bufferTail(record, line);
          this._scanForCommentTool(record, line);
          this.#maybeEmitChatProgress(record, line);
          this.#captureUsageLine(record, line);
        }
        log(`${tagFor(record)} ${line}`);
      });
    }
    if (child.stderr) {
      const rlErr = createInterface({ input: child.stderr });
      rlErr.on('line', (line) => {
        const rec = this.#map.get(pid);
        const record = rec && rec.kind !== 'reservation' ? (rec as SubagentRecord) : undefined;
        if (record) {
          this.#bufferTail(record, line);
          // pi's print mode reserves stdout for the final answer and routes
          // extension console output (including awb-mcp-bridge's successful
          // tool-call sentinel) to stderr. Other adapters already expose
          // their structured tool events on stdout, so keep this extra scan
          // pi-specific instead of treating arbitrary diagnostics as events.
          if (record.cli_type === 'pi') this._scanForCommentTool(record, line);
        }
        log(`${tagFor(record)}[err] ${line}`);
      });
    }
  }

  /** stdout/stderr 한 줄을 silent-exit tail 링에 추가한다. 일반 텍스트 줄은
   *  그대로 보존하고, stream-json 이벤트는 버리지 않고 짧은 프로즈 요약으로
   *  압축한다(assistant 텍스트 / tool_use / result subtype+error) — stream-json
   *  모드에서는 stdout의 거의 모든 줄이 JSON이라, 요약 없이 버리면 silent-exit
   *  fallback의 tail이 거의 항상 비어 있었다(ticket ac958c06). 노이즈 이벤트는
   *  null로 요약되어 스킵된다. TAIL_RING_MAX_LINES로 상한이 걸린다. */
  #bufferTail(record: SubagentRecord, line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let entry: string | null = trimmed;
    if (trimmed.startsWith('{')) {
      entry = summarizeCliJsonLine(trimmed);
      if (!entry) return; // JSON noise (init / normal tool_result) — skip.
    }
    record.tailLines.push(entry);
    while (record.tailLines.length > TAIL_RING_MAX_LINES) record.tailLines.shift();
  }

  /** Best-effort per-line usage capture (ticket 6dd3f968). Only result-shaped
   *  lines carry usage, so this re-parses via the SAME adapter that spawned
   *  the child (never claude's parser against a codex line, etc.) and folds
   *  any snapshot into the record's running total. Usage is a nice-to-have
   *  observability signal, never a dispatch/comment/circuit-breaker input —
   *  any failure here is caught and logged, never rethrown. */
  #captureUsageLine(record: SubagentRecord, line: string): void {
    try {
      const adapter = this.#adapterFor(record.cli_type);
      const parsed = adapter.parseStdoutLine(line);
      if (!parsed.isResult || !parsed.raw) return;
      const snapshot = adapter.extractUsage(parsed.raw);
      if (!snapshot) return;
      record.usage = accumulateUsage(record.usage, snapshot);
    } catch (err: any) {
      log(`[subagent] usage capture failed pid=${record.pid}: ${err?.message ?? err}`);
    }
  }

  /** Watch parsed JSONL for successful Claude, Codex, or pi MCP calls that create
   *  ticket comments. Kept as a test seam because a missed event causes a
   *  misleading system fallback comment after otherwise successful work. */
  _scanForCommentTool(record: SubagentRecord, line: string): void {
    if (record.commentSent) return;
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return;
    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    const isCommentTool = (name: unknown): boolean =>
      typeof name === 'string' && TICKET_COMMENT_TOOL_SUFFIXES.some((suffix) => name.endsWith(suffix));

    if (parsed?.type === 'item.completed' && parsed?.item?.type === 'mcp_tool_call') {
      const item = parsed.item;
      if (item.server === 'awb' && item.error == null && isCommentTool(item.tool ?? item.name)) {
        record.commentSent = true;
      }
      return;
    }

    // pi's awb-mcp-bridge.ts extension (tickets d5a6100d, 68cda8eb) — pi's
    // `-p` mode has no structured turn events of its own. The bridge emits
    // this sentinel after each successful AWB tool call; pi routes extension
    // console output to stderr, which #wireStdioCapture scans for pi only.
    if (parsed?.type === 'awb_mcp_bridge_tool_call') {
      if (parsed.server === 'awb' && parsed.error == null && isCommentTool(parsed.tool)) {
        record.commentSent = true;
      }
      return;
    }

    if (parsed?.type === 'assistant') {
      const content = parsed?.message?.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (block?.type === 'tool_use' && isCommentTool(block.name)) {
          record.commentSent = true;
          return;
        }
      }
    }
  }

  async #postOneshotAnswer(record: SubagentRecord, answer: string): Promise<void> {
    const MAX = 60_000;
    const trimmed = answer.length > MAX ? answer.slice(0, MAX) + '\n\n…[truncated]' : answer;
    await fireAndForgetTool(this.#config, 'add_comment', {
      ticket_id: record.ticket_id,
      content: trimmed,
      type: 'note',
    });
    // Treat the aggregated one-shot answer as the audit-trail comment so
    // the silent-exit fallback doesn't double-post a `system` row on top
    // of the legitimate `note` that this method just dispatched.
    record.commentSent = true;
    log(
      `Subagent posted answer to ticket=${record.ticket_id} (cli=${record.cli_type}, ${trimmed.length} chars)`,
    );
  }

  /** Post a `system`-type comment to a ticket whose one-shot subagent
   *  exited without leaving any audit-trail comment (or with a non-zero
   *  exit code). Mirrors the persistent-session path in
   *  `TicketSessionManager#postSilentExitFallback` so the board sees
   *  identical fallback rows whether the subagent ran one-shot or in a
   *  persistent CLI child. Best-effort: a failed POST is logged. */
  async #postSilentExitFallback(
    record: SubagentRecord,
    code: number | null,
  ): Promise<'created' | 'suppressed' | 'failed'> {
    const ticketId = record.ticket_id || '';
    if (!ticketId) return 'failed';
    const tail = this.#collectTail(record);
    const exitLabel = code === null ? 'null' : String(code);
    const reasonLabel = code === 0
      ? 'no audit-trail comments + clean exit'
      : `non-zero exit code ${exitLabel}`;
    const triggerId = record.trigger_id || '';
    const header = `⚠️ Subagent exited without leaving a ticket comment (${reasonLabel}).`;
    const metaParts: string[] = [];
    metaParts.push(`cli=${record.cli_type}`);
    metaParts.push(`exit_code=${exitLabel}`);
    if (record.silent_exit_attempt !== undefined) {
      metaParts.push(`attempt=${record.silent_exit_attempt}`);
      if (record.silent_exit_attempt === 1) {
        metaParts.push(`reason=${record.silent_exit_terminal_reason || 'silent_exit_retry_exhausted'}`);
      }
    }
    // Structured failure reason (usage_limit / auth_failure / codex_error) when
    // the buffered tail matches a known fatal signature — the "structured
    // failure reason" half of the acceptance criteria (ticket ac958c06), even
    // when the prose tail itself is terse.
    const classified = classifyCliError(tail, { exitCode: code });
    if (classified.isFatal && classified.reason) metaParts.push(`reason=${classified.reason}`);
    if (triggerId) metaParts.push(`trigger=${triggerId}`);
    const metaLine = `_${metaParts.join(' · ')}_`;
    const body = tail
      ? `${header}\n\n${metaLine}\n\nLast CLI output:\n\`\`\`\n${tail}\n\`\`\``
      : `${header}\n\n${metaLine}\n\n(no buffered CLI output captured)`;

    log(
      `Subagent silent-exit fallback dispatched ticket=${ticketId.slice(0, 8)} pid=${record.pid} ` +
        `cli=${record.cli_type} exit=${exitLabel} trigger=${triggerId.slice(0, 8) || '-'} outputLen=${tail.length}`,
    );
    return postSilentExitSystemComment(this.#config, ticketId, {
      content: body,
      exit_code: code,
      cycle_trigger_id: triggerId,
      role: record.role || '',
      actor_name: 'agent-manager',
      agent_id: record.agent_id || undefined,
      subagent_session_id: record.audit_session_id || String(record.pid),
      cycle_started_at: new Date(record.started_at).toISOString(),
      silent_exit_attempt: record.silent_exit_attempt,
      terminal_reason: record.silent_exit_attempt === 1
        ? record.silent_exit_terminal_reason || 'silent_exit_retry_exhausted'
        : undefined,
      silent_exit_family_key: record.silent_exit_family_key,
      silent_exit_retry_count: record.silent_exit_attempt,
    });
  }

  /** Join the tail ring and trim to SILENT_EXIT_TAIL_MAX_CHARS, keeping
   *  the last slice. Returns '' when nothing was buffered. */
  #collectTail(record: SubagentRecord): string {
    if (!record.tailLines.length) return '';
    let body = record.tailLines.join('\n').trim();
    if (body.length > SILENT_EXIT_TAIL_MAX_CHARS) {
      body = '…' + body.slice(-SILENT_EXIT_TAIL_MAX_CHARS);
    }
    return body;
  }

  async #postOneshotChatAnswer(record: SubagentRecord, answer: string): Promise<void> {
    const MAX = 60_000;
    const trimmed = answer.length > MAX ? answer.slice(0, MAX) + '\n\n…[truncated]' : answer;
    const agentId = record.agent_id || '';
    await postChatRoomMessage(this.#config, record.room_id!, agentId, trimmed);
    log(
      `Subagent posted chat answer to room=${record.room_id} agent=${agentId.slice(0, 8)} (cli=${record.cli_type}, ${trimmed.length} chars)`,
    );
  }

  /**
   * ticket c47194d9 — surface a CHAT one-shot's in-flight work as
   * `type='progress'` chat heartbeats so a Codex chat shows what it's doing in
   * the chat window, like Claude's persistent session already does. Only chat
   * spawns (room_id set) qualify — ticket work reports through comments, not the
   * chat window. The adapter (`parseProgressEvent`) decides what, if anything, a
   * given stdout line means: Codex maps its `item.*` / `turn.failed` events;
   * claude/antigravity default to null here (claude chat takes the persistent
   * ChatSessionManager route). Best-effort — a bad line never breaks capture. */
  #maybeEmitChatProgress(record: SubagentRecord, line: string): void {
    if (!record.room_id) return;
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return;
    let obj: any;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return;
    }
    let ev: CliProgressEvent | null = null;
    try {
      ev = this.#adapterFor(record.cli_type).parseProgressEvent(obj);
    } catch {
      return;
    }
    if (ev) this.#emitChatProgress(record, ev);
  }

  /** Post one coalesced, capped progress heartbeat for a chat one-shot. Mirrors
   *  ChatSessionManager#emitProgress: rate-limited per pid so a burst of item.*
   *  events doesn't flood the room, and hard-capped per session (progress is a
   *  heartbeat, the agent's actual reply is what the user waits for). A terminal
   *  실패 (`ev.status === 'error'`) bypasses BOTH the interval and the cap so the
   *  failure is never coalesced or dropped — but only the first one per pid
   *  (dedupe via meta.errorEmitted) so repeated error lines can't flood the room
   *  once the cap is otherwise exhausted.
   *  Fire-and-forget — postChatRoomMessage swallows + logs its own errors. */
  #emitChatProgress(record: SubagentRecord, ev: CliProgressEvent): void {
    const pid = record.pid;
    let meta = this.#progressMeta.get(pid);
    if (!meta) {
      meta = { lastEmitMs: 0, count: 0, errorEmitted: false };
      this.#progressMeta.set(pid, meta);
    }
    const now = Date.now();
    const isError = ev.status === 'error';
    if (isError) {
      // 완료 기준: 실패는 항상 명확히 구분되어야 하므로 terminal 실패는 heartbeat
      // interval 과 per-session cap 을 모두 우회한다. 단, cap 소진 후 반복되는
      // error 라인이 방을 도배하지 않도록 pid 당 terminal error 슬롯을 하나만
      // 예약(dedupe)한다 — 첫 실패만 방출하고 이후 error 는 무시.
      if (meta.errorEmitted) return;
    } else {
      // 일반 heartbeat: item.* 버스트가 방을 도배하지 않도록 rate-limit + hard-cap.
      if (meta.count >= CHAT_PROGRESS_MAX_PER_SESSION) return;
      if (now - meta.lastEmitMs < CHAT_PROGRESS_MIN_INTERVAL_MS) return;
    }
    const message = this.#formatChatProgressLine(ev);
    if (!message) return;
    meta.lastEmitMs = now;
    meta.count += 1;
    if (isError) meta.errorEmitted = true;
    const agentId = record.agent_id || '';
    // type='progress' → server stamps the discriminator so the chat UI renders a
    // muted italic heartbeat and agent history replays exclude it.
    void postChatRoomMessage(this.#config, record.room_id!, agentId, message, {
      type: 'progress',
    });
  }

  /** Render a normalized progress event into the italic `_..._` line the chat
   *  UI expects (the client strips the wrapper). The three states are visually
   *  distinct: 작업 중 → kind icon; 완료 → ✅; 실패 → ⚠️. */
  #formatChatProgressLine(ev: CliProgressEvent): string {
    const label = this.#clipProgress(ev.label || '', CHAT_PROGRESS_LABEL_MAX) || '작업';
    const detail = this.#clipProgress(ev.detail || '', CHAT_PROGRESS_DETAIL_MAX);
    const tail = detail ? ` · ${detail}` : '';
    if (ev.status === 'error') return `_⚠️ ${label} 실패${tail}_`;
    if (ev.status === 'success') return `_✅ ${label} 완료${tail}_`;
    return `_${this.#progressKindIcon(ev.kind)} ${label}${tail}_`;
  }

  #progressKindIcon(kind: CliProgressEvent['kind']): string {
    switch (kind) {
      case 'command':
        return '💻';
      case 'tool':
        return '📋';
      case 'file':
        return '✏️';
      case 'search':
        return '🌐';
      case 'task':
        return '🤖';
      default:
        return '🔧';
    }
  }

  /** Collapse whitespace, truncate, and neutralize markdown so a backtick /
   *  underscore in a command or path can't break the italic `_..._` wrapper. */
  #clipProgress(s: string, max: number): string {
    let out = String(s ?? '').replace(/\s+/g, ' ').trim();
    if (!out) return '';
    if (out.length > max) out = out.slice(0, max - 1) + '…';
    return out.replace(/[`_*]/g, (c) => `\\${c}`);
  }

  async #sweep(): Promise<void> {
    if (this.#sweepInFlight) {
      log('Sweep: previous pass still in flight (live-task probe pending), skipping this tick');
      return;
    }
    this.#sweepInFlight = true;
    try {
      const now = Date.now();
      const ttlExpired: Array<[number, SubagentRecord]> = [];
      for (const [pid, record] of this.#map.entries()) {
        if (record.kind === 'reservation') continue;
        try {
          process.kill(pid, 0);
        } catch (err: any) {
          if (err?.code === 'ESRCH' || err?.code === 'EPERM') {
            log(`Sweep: pid=${pid} no longer alive, removing record`);
            this.#map.delete(pid);
            if (record.config_path && record.config_path_is_temp) {
              fsp.rm(dirname(record.config_path), { recursive: true, force: true }).catch(() => {});
            }
            continue;
          }
        }
        if (now >= record.expected_completion_at) {
          ttlExpired.push([pid, record]);
        }
      }

      for (const [pid, record] of ttlExpired) {
        // A concurrent path (stopForAgent / restart_agent / a genuine exit)
        // may have already dropped this record while an earlier candidate in
        // this same pass was awaiting its own live-task probe below.
        if (this.#map.get(pid) !== record) continue;

        // ticket b972b28c: a wall-clock TTL alone is not evidence of a stuck
        // subagent — a timer expiring means CHECK, not KILL (same governing
        // principle as BaseSessionManager's idle reaper, ticket 6ff827cb).
        // Minimum signal: a live non-benign descendant process (e.g. a
        // build/test the subagent spawned and is waiting on) means real work
        // is in flight — slide the deadline instead of reaping it out from
        // under that work.
        let liveTasks: ProcNode[] = [];
        try {
          liveTasks = await findLiveBackgroundTasks(pid);
        } catch (err: any) {
          log(`Sweep: pid=${pid} live-task probe failed, proceeding with TTL reap: ${err?.message ?? err}`);
        }
        if (this.#map.get(pid) !== record) continue; // dropped while we awaited

        if (liveTasks.length > 0) {
          record.expected_completion_at = now + TTL_SWEEP_INTERVAL_MS;
          log(
            `Sweep: pid=${pid} exceeded TTL but ${liveTasks.length} live background task(s) found — sliding expected_completion_at`,
          );
          this.#maybeEscalateLongRunning(pid, record);
          continue;
        }

        log(`Sweep: pid=${pid} exceeded TTL, sending SIGTERM`);
        // Drop-first, exactly like stopForAgent / restart_agent (ticket
        // c555fbb6). Remove the record from #map BEFORE signalling so the
        // per-child exit handler early-returns (see #wireExitHandler) instead
        // of running _handleOneshotExit. A TTL idle timeout is a
        // manager-initiated reap, NOT a delivery failure — the circuit-breaker
        // contract classifies a SIGTERM idle-timeout as transient
        // (circuit-breaker.ts TRANSIENT_EXIT_CODES). If we left the record in
        // #map the SIGTERM would surface as code=null in _handleOneshotExit
        // and, for a subagent that was simply slow and hadn't posted its
        // comment yet (commentSent=false), get counted toward the breaker —
        // falsely pending a healthy ticket after 5 idle timeouts. Because the
        // exit handler no longer runs, we own the temp-cfg cleanup here in the
        // grace timer (mirrors stopForAgent), using the same dir-rm as the
        // ESRCH branch above so both sweep exit paths clean up identically.
        this.#map.delete(pid);
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          /* already dead */
        }
        setTimeout(() => {
          try {
            process.kill(pid, 0);
            log(`Sweep: pid=${pid} still alive after SIGTERM grace, sending SIGKILL`);
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              /* ignore */
            }
          } catch {
            /* already exited */
          }
          if (record.config_path && record.config_path_is_temp) {
            fsp.rm(dirname(record.config_path), { recursive: true, force: true }).catch(() => {});
          }
        }, SIGTERM_GRACE_MS);
      }
      this.#persist();
    } finally {
      this.#sweepInFlight = false;
    }
  }

  /** ticket b972b28c — mirrors BaseSessionManager's gap-4 principle (ticket
   *  6ff827cb): a one-shot that keeps producing live-background-task
   *  evidence forever is the one real risk the sliding-TTL extension opens
   *  up (a genuine runaway loop looks identical to real work from the
   *  outside). Past subagentProgressEscalationHours it is NOT killed — that
   *  would violate the governing principle for a subagent with real
   *  evidence — but it gets ONE log line so an operator can look. */
  #maybeEscalateLongRunning(pid: number, record: SubagentRecord): void {
    if (record.progressEscalatedAt) return;
    const hours = this.#config.delegation.subagentProgressEscalationHours ?? 4;
    const ageMs = Date.now() - record.started_at;
    if (ageMs < hours * 3_600_000) return;
    record.progressEscalatedAt = Date.now();
    const ageHours = (ageMs / 3_600_000).toFixed(1);
    log(
      `Sweep: ESCALATION pid=${pid} ticket=${record.ticket_id ?? ''} agent=${record.agent_id ?? ''} — ` +
        `one-shot running ${ageHours}h with continuous background-task evidence past TTL; verify this isn't a runaway loop`,
    );
  }

  async #reconcileOnStart(): Promise<void> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.#persistPath, 'utf8');
    } catch {
      return;
    }
    let persisted: any[];
    try {
      persisted = JSON.parse(raw).pids || [];
    } catch {
      return;
    }

    let revived = 0,
      dropped = 0;
    for (const rec of persisted) {
      if (!rec || !rec.pid) continue;
      try {
        process.kill(rec.pid, 0);
        // Default `config_path_is_temp` to true for legacy persisted records
        // missing the field — that matches the pre-ST-6 cleanup behavior.
        this.#map.set(rec.pid, {
          ...rec,
          role: rec.role ?? null,
          config_path_is_temp: rec.config_path_is_temp ?? true,
          process_handle: null,
          outLines: rec.outLines || [],
          // Tail ring + commentSent are runtime-only — revived from
          // persistence means we missed the live exit and won't be running
          // the silent-exit fallback for this pid anyway, but the fields
          // need defaults so the TypeScript shape stays consistent.
          tailLines: [],
          commentSent: rec.commentSent ?? false,
        });
        revived++;
      } catch (err: any) {
        if (err?.code === 'ESRCH' || err?.code === 'EPERM') dropped++;
      }
    }
    if (revived || dropped) {
      log(`SubagentManager reconciled: revived=${revived} dropped=${dropped}`);
    }
    this.#persist();
  }

  #persist(): void {
    const pids: any[] = [];
    for (const rec of this.#map.values()) {
      if (rec.kind === 'reservation') continue;
      const { process_handle, outLines, tailLines, tap, respawnSpec, ...serializable } = rec;
      void process_handle;
      void outLines;
      void tailLines;
      void tap;
      void respawnSpec;
      pids.push(serializable);
    }
    fsp
      .writeFile(this.#persistPath, JSON.stringify({ pids }, null, 2))
      .catch((err: any) => log(`SubagentManager persist failed: ${err?.message ?? err}`));
  }

  /**
   * Force-terminate every live one-shot subagent owned by `agentId`. The
   * zombie-reaper half of restart_agent: a one-shot trigger / chat / mention
   * subagent that spawned under an expired OAuth credential keeps running
   * detached (it captured the apiKey + cli-home env at spawn time), so a
   * credential rotation never reaches it — it just keeps burning turns
   * against the dead token until its TTL sweep retires it. stop_agent only
   * tore down persistent ticket/chat sessions; one-shots were never wired in.
   *
   * SIGTERM first, then SIGKILL after STOP_GRACE_MS for any survivor — same
   * escalation as stop() / BaseSessionManager.stopForAgent. Records are
   * dropped from the map up front so a concurrent dispatch can't reuse them.
   * Because the record is gone, the per-child exit handler early-returns and
   * does NOT run its usual cleanup — so we unlink each victim's temp config
   * here ourselves (inside the SIGKILL-grace timer). The other exit-handler
   * side effects are intentionally skipped: the silent-exit "⚠️ exited (143)"
   * fallback would just spam each reaped ticket, and onExit only logs. Returns
   * the count plus the in-flight (ticket, role) pairs the victims were holding
   * so restart_agent can re-push them immediately on the fresh credential.
   */
  async stopForAgent(agentId: string): Promise<SubagentStopForAgentResult> {
    if (!agentId) return { count: 0, inflight: [] };
    const victims: SubagentRecord[] = [];
    for (const [pid, rec] of this.#map.entries()) {
      if (rec.kind === 'reservation') continue;
      if (rec.agent_id !== agentId) continue;
      victims.push(rec);
      this.#map.delete(pid);
    }
    if (victims.length === 0) return { count: 0, inflight: [] };

    for (const rec of victims) {
      try {
        process.kill(rec.pid, 'SIGTERM');
      } catch {
        /* already dead */
      }
    }
    log(
      `SubagentManager stopForAgent: agent=${agentId.slice(0, 8)} signalled ${victims.length} one-shot subagent(s) — SIGTERM`,
    );
    setTimeout(() => {
      for (const rec of victims) {
        try {
          process.kill(rec.pid, 0);
          try {
            process.kill(rec.pid, 'SIGKILL');
          } catch {
            /* gone between probe and kill */
          }
        } catch {
          /* already exited */
        }
        // The per-child exit handler can't clean up after us: we removed the
        // record from #map above, so it early-returns (see #wireExitHandler)
        // and never unlinks the temp config. Unlink it ourselves so reaped
        // role-pinned trigger subagents don't strand their credential-bearing
        // cfg-*.json — the exact token hygiene this reap exists to enforce.
        if (rec.config_path && rec.config_path_is_temp) {
          fsp.unlink(rec.config_path).catch(() => {});
        }
      }
    }, STOP_GRACE_MS).unref?.();

    this.#persist();
    return {
      count: victims.length,
      inflight: victims.map((rec) => ({
        ticket_id: rec.ticket_id,
        role: rec.role,
        room_id: rec.room_id,
      })),
    };
  }

  /**
   * ticket 6abe2b79: stopForAgent / #sweep 와 달리, 시그널을 보내기 전에 각
   * victim 을 #map 에서 미리 지우지 않는다. drop-first 방식이면 매니저
   * shutdown 킬마다 #wireExitHandler 의 #map 조회가 무조건 실패해, 이 프로세스가
   * 돌리던 oneshot Action/QA run 이 _runExitCompletionBackstop 에 절대 닿지
   * 못하고 서버에서 2시간 TTL reaper 까지 `running` 으로 방치됐다. 대신 사유를
   * 태그하고 레코드를 그대로 남겨 둔다 — 실제 exit 핸들러가 이를 찾아내고,
   * _handleOneshotExit 의 stopReason 체크가 크래시 오계상 로직을 건너뛰며
   * (#sweep/stopForAgent 가 drop-first 로 지켜온 "reap ≠ 배달 실패" 보장을
   * 그대로 유지), run-completion backstop 은 이제 침묵 대신 실제 사유를 담아
   * 정상 발화한다. reservation 은 자식 프로세스도 exit 핸들러도 없으므로
   * 기존과 동일하게 즉시 지운다.
   *
   * 리뷰 지적 반영(라운드2): SIGKILL 을 보낸 직후 곧바로 반환하면, 호출자
   * (main.ts shutdown())가 뒤이어 다른 정리 단계를 거쳐 곧 process.exit() 하는
   * 사이에 SIGKILL 대상의 'close' 이벤트와 그 안의 run-completion backstop 이
   * 미처 못 끝나고 프로세스와 함께 잘려나갈 수 있다 — drop-first 버그와 증상만
   * 다를 뿐 같은 무음 유실 클래스다. 그래서 SIGKILL 이후 각 victim 의 실제 exit
   * 핸들러(정리+backstop)가 끝나길 STOP_FORCE_KILL_SETTLE_MS 상한을 두고
   * 기다린다(#stopWaiters, #wireExitHandler 가 완료 시 resolve). 상한을 넘겨도
   * (예: SIGKILL 에도 안 죽는 병적인 케이스) 조용히 포기하지 않고, 그 victim 에
   * 한해 이 메서드가 직접 한 번 더 completion backstop 을 호출해 "close 가
   * 끝내 안 와도 정확히 1회는 보고된다"는 계약을 지킨다.
   *
   * 리뷰 지적 반영(라운드3): #stopWaiters 삭제만으로는 중복 호출을 막지
   * 못한다 — 그건 "누가 대기 중인지"만 추적할 뿐, "누가 completion 을 부를
   * 권리를 가졌는지"는 별개다. 실제 close 가 이 fallback 의 await 도중 뒤늦게
   * 와도 양쪽이 같은 record.run 을 보고 둘 다 completion 을 부를 수 있었다.
   * 지금은 #claimRun 으로 record.run 을 await 하기 *전에* 동기적으로 떼어내
   * (읽기+null 대입이 한 동기 구간), 실제 exit 핸들러도 동일한 메서드로만
   * record.run 을 읽으므로 둘 중 먼저 그 동기 구간을 통과하는 쪽만 완료
   * 처리한다 — 서버측 멱등성은 상태 손상을 막는 안전판일 뿐, 이게 "정확히
   * 1회 호출"을 보장하는 진짜 메커니즘이다.
   *
   * 리뷰 지적 반영(라운드4): 라운드3 은 "정확히 한 경로만 부른다"는 지켰지만
   * "그 경로가 실제로 끝나길 기다린다"는 안 지켰다 — 실제 exit 핸들러가 먼저
   * #claimRun 에 성공한 뒤 _sweepOneshotRunOrphans/_runExitCompletionBackstop
   * 의 await 도중 STOP_FORCE_KILL_SETTLE_MS 가 만료되면, fallback 의
   * #claimRun 은 null 을 받아 스킵하고 stop() 은 그대로 반환해 버렸다 — exit
   * 핸들러가 들고 있는 completion 요청이 호출자의 뒤이은 process.exit() 에
   * 잘려나갈 수 있는, 증상만 다른 같은 무음 유실이다. 그래서 victim 각각을
   * 독립적으로 처리한다: 1차 상한 안에 자연 정착(#stopWaiters 의 resolve)되면
   * 끝, 상한을 넘겼는데 #claimRun 이 값을 얻으면(=아무도 안 가져감) fallback
   * 이 직접 완료 처리, #claimRun 이 null 이면(=exit 핸들러가 이미 작업 중)
   * 포기하지 않고 그 기존 완료 promise 를 2차 상한만큼 한 번 더 기다린다.
   */
  async stop(reason?: string): Promise<void> {
    if (this.#sweepTimer) {
      clearInterval(this.#sweepTimer);
      this.#sweepTimer = null;
    }
    const stopReason = reason || 'manager_shutdown';
    const victims: SubagentRecord[] = [];
    const settledByPid = new Map<number, Promise<void>>();
    for (const [pid, rec] of this.#map.entries()) {
      if (rec.kind === 'reservation') {
        this.#map.delete(pid);
        continue;
      }
      rec.stopReason = stopReason;
      victims.push(rec);
      settledByPid.set(
        rec.pid,
        new Promise<void>((resolve) => {
          this.#stopWaiters.set(rec.pid, resolve);
        }),
      );
    }
    for (const rec of victims) {
      try {
        process.kill(rec.pid, 'SIGTERM');
      } catch {
        /* dead */
      }
    }
    if (victims.length === 0) return;
    await new Promise((r) => setTimeout(r, STOP_GRACE_MS));
    for (const rec of victims) {
      try {
        process.kill(rec.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    // 이제 각 victim 의 'close' 이벤트가 도착하면 실제 exit 핸들러가 #map
    // 정리 + temp-config unlink 를 그대로 담당한다(stop() 이 수동으로
    // 중복하던 것을 보통의 oneshot exit 과 동일하게 흡수). 아래는 victim 마다
    // 독립적으로 "자연 정착 대기 → 못 끝났으면 누가 completion 을 들고
    // 있는지 확인 → 아무도 없으면 fallback 이 직접, 이미 누가 있으면 그
    // 완료를 한 번 더 대기"를 수행한다.
    await Promise.all(
      victims.map(async (rec) => {
        const settled = settledByPid.get(rec.pid)!;
        const firstRoundTimedOut = await Promise.race([
          settled.then(() => false as const),
          new Promise<true>((resolve) => {
            setTimeout(() => resolve(true), STOP_FORCE_KILL_SETTLE_MS).unref?.();
          }),
        ]);
        if (!firstRoundTimedOut) return; // 실제 exit 핸들러가 정상적으로 끝냄

        const claimedRun = this.#claimRun(rec);
        if (claimedRun) {
          // 아무도 안 가져갔다 — exit 핸들러가 아예 시작도 못 한 경우(예:
          // SIGKILL 에도 안 죽는 병적인 케이스). fallback 이 직접 완료 처리.
          this.#stopWaiters.delete(rec.pid);
          try {
            await this._runExitCompletionBackstop(rec, null, claimedRun);
          } catch (err: any) {
            log(`[subagent] stop() force-kill fallback backstop failed pid=${rec.pid}: ${err?.message ?? err}`);
          }
          return;
        }
        // 이미 실제 exit 핸들러가 #claimRun 으로 가져가 작업 중이다 — 포기하지
        // 않고 그 기존 완료 promise 를 한 번 더(상한 두 배까지) 기다린다.
        await Promise.race([
          settled,
          new Promise<void>((resolve) => setTimeout(resolve, STOP_FORCE_KILL_SETTLE_MS).unref?.()),
        ]);
      }),
    );
    this.#persist();
    log(`SubagentManager stopped (terminated ${victims.length} children, reason=${stopReason})`);
  }

  _snapshot(): any[] {
    const out: any[] = [];
    for (const rec of this.#map.values()) {
      if (rec.kind === 'reservation') continue;
      const { process_handle, outLines, tailLines, tap, ...serializable } = rec;
      void process_handle;
      void outLines;
      void tailLines;
      void tap;
      out.push(serializable);
    }
    return out;
  }

  /**
   * Test seam (ticket c555fbb6): register a record straight into #map and wire
   * the REAL exit handler onto its process_handle, so a unit test can exercise
   * the #wireExitHandler reap-vs-unexpected-death gating (a dropped record's
   * exit early-returns and is NOT counted) without forking a real CLI. Mirrors
   * the tail of spawn() — map.set + #wireExitHandler — for a caller-built record
   * plus a (usually fake EventEmitter) child handle.
   */
  _trackForTest(record: SubagentRecord): void {
    this.#map.set(record.pid, record);
    this.#wireExitHandler(record.process_handle as ChildProcess, record.pid);
  }

  /** Test seam (ticket c555fbb6; async-ified for ticket b972b28c): run one
   *  TTL/progress-gate #sweep pass. Returns the pass's promise so a test can
   *  await the async live-task probe before asserting drop-first / kill /
   *  slide outcomes deterministically. */
  _sweepNow(): Promise<void> {
    return this.#sweep();
  }

  /**
   * Test seam (ticket c47194d9): register a record and wire the REAL stdout /
   * stderr capture — including the chat-progress heartbeat path — onto its
   * process_handle, so a unit test can feed `codex exec --json` JSONL lines
   * through the true #wireStdioCapture → parseProgressEvent → postChatRoomMessage
   * chain without forking a CLI. The stdio twin of _trackForTest.
   */
  _wireStdioForTest(record: SubagentRecord): void {
    this.#map.set(record.pid, record);
    this.#wireStdioCapture(record.process_handle as ChildProcess, record.pid);
  }
}
