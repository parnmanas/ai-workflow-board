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
import { spawn, type ChildProcess } from 'node:child_process';
import {
  SUBAGENTS_BASE_DIR,
  SUBAGENTS_PERSIST_PATH,
  TTL_SWEEP_INTERVAL_MS,
  SIGTERM_GRACE_MS,
  STOP_GRACE_MS,
} from './constants.js';
import { log } from './logging.js';
import { createAdapter } from './cli-adapters/index.js';
import {
  ADAPTER_CAPABILITIES,
  type CliAdapter,
  describeHarness,
  partitionHarness,
  selectEffortSlice,
} from './cli-adapters/base.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { writeMcpConfig } from './managed-agent-store.js';
import { classifyCliError } from './cli-error-signatures.js';
import { summarizeCliJsonLine } from './cli-output-summary.js';
import { fireAndForgetTool } from './mcp-client.js';
import {
  postChatRoomMessage,
  postSilentExitSystemComment,
  type AwbConfig,
} from './rest.js';
import type {
  SubagentManager as SubagentManagerContract,
  SubagentSpawnArgs,
  SubagentSpawnResult,
} from './event-dispatcher.js';
import type { SubagentMonitor, SubagentTapHandle } from './subagent-monitor.js';

const { NATIVE_MCP } = ADAPTER_CAPABILITIES;

/** Max lines kept in the per-pid plain-text tail ring used by the
 *  silent-exit fallback. Bounded so a chatty subagent can't blow the
 *  manager's memory if it never exits cleanly. */
const TAIL_RING_MAX_LINES = 100;
/** Max bytes of `tail.join('\n')` posted in the silent-exit system
 *  comment. 4KB keeps the comment readable in the board UI. */
const SILENT_EXIT_TAIL_MAX_CHARS = 4096;
/** MCP tool name suffixes that count as the subagent leaving a real
 *  ticket comment. Matched by suffix so a future MCP prefix rename
 *  doesn't break detection. Keep aligned with the ticket-session list. */
const TICKET_COMMENT_TOOL_SUFFIXES = [
  'add_comment',
  'ask_question',
  'answer_question',
  'record_decision',
  'handoff_to_agent',
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
export function mentionTriggerId(commentId: string, agentId?: string): string {
  return `mention:${commentId}:${agentId || ''}`;
}

export interface SubagentDelegationConfig {
  enabled?: boolean;
  maxConcurrent?: number;
  ttlMinutes?: number;
  claudeBin?: string;
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
  #adapters = new Map<string, CliAdapter>();
  #sweepTimer: NodeJS.Timeout | null = null;
  #reservationCounter = 0;
  #persistPath: string;
  #pidDir: string;
  #initialized = false;
  #monitor: SubagentMonitor | null = null;

  /** Circuit-breaker for the one-shot path. Blocks re-spawn to an (agent,
   *  ticket, role) that repeatedly exits with non-transient errors and pends
   *  the ticket when it opens — the same protection the persistent
   *  TicketSessionManager already had. Injected from main.ts so it is SHARED
   *  with the persistent path: a (ticket,role) that fails N times across both
   *  paths counts once, and restart_agent's resetAgent() clears both. Falls
   *  back to a private instance when constructed without one (unit tests). */
  readonly circuitBreaker: CircuitBreaker;

  onExit?: (info: SubagentExitInfo) => void;

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
    this.#sweepTimer = setInterval(() => this.#sweep(), TTL_SWEEP_INTERVAL_MS);
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
    const t = String(cli || 'claude').toLowerCase();
    let a = this.#adapters.get(t);
    if (!a) {
      a = createAdapter(t);
      this.#adapters.set(t, a);
    }
    return a;
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
    if (spec.kind === 'trigger' && spec.ticketId && spec.agentId) {
      const cbKey = CircuitBreaker.key(spec.agentId, spec.ticketId, spec.role || '');
      const blockReason = this.circuitBreaker.shouldBlock(cbKey);
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
    const effectiveModel = slice?.model ?? harness?.model ?? ctx?.model ?? null;
    const effortFlag = slice?.effort ?? null;
    const ultracode = !!slice?.ultracode;
    if (slice && (effortFlag || ultracode || slice.model)) {
      log(
        `[subagent] effort applied: ticket=${spec.ticketId.slice(0, 8) || '-'} cli=${adapter.cliType} ` +
          `effort=${effortFlag ?? '-'} ultracode=${ultracode} model=${slice.model ?? '-'}`,
      );
    }
    let configPath: string | null = null;
    let configPathIsTemp = false;
    try {
      const descriptor = adapter.buildOneshotSpawn({
        rolePrompt: spec.rolePrompt || '',
        taskText: spec.taskText,
        mcpConfigPath: null,
        model: effectiveModel,
        harness,
        effort: effortFlag,
        ultracode,
      });

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
          // Reuse the static per-agent mcp-config.json for non-role spawns. If
          // it vanished from disk (partial spawn / manual cleanup / pre-file
          // manager upgrade), the CLI would fail with "MCP config file not
          // found" — regenerate it in place from the in-context apiKey.
          // Regeneration preserves the host stdio server the temp else-branch
          // below would drop.
          configPath = existsSync(ctx.mcp_config_path)
            ? ctx.mcp_config_path
            : await writeMcpConfig(ctx.agent_id, this.#config.url, effectiveApiKey);
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
          };
          if (spec.ticketId) headers['X-AWB-Subagent-Ticket-Id'] = spec.ticketId;
          if (spec.role) headers['X-AWB-Subagent-Role'] = spec.role;
          if (spec.triggerSource) headers['X-AWB-Subagent-Trigger-Source'] = spec.triggerSource;
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
          adapter.buildOneshotSpawn({
            rolePrompt: spec.rolePrompt || '',
            taskText: spec.taskText,
            mcpConfigPath: configPath,
            model: effectiveModel,
            harness,
            effort: effortFlag,
            ultracode,
          }),
        );
      }

      // See base-session-manager: `delegation.claudeBin` is claude-only;
      // forwarding it to codex / antigravity spawned the wrong binary.
      const binOverride =
        adapter.cliType === 'claude' ? this.#config.delegation.claudeBin : null;
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
      // detached on Windows is incompatible with windowsHide: DETACHED_PROCESS
      // (set by node when detached: true on win32) is mutually exclusive with
      // CREATE_NO_WINDOW, so the cmd.exe shell that wraps .cmd/.bat targets
      // ends up calling AllocConsole() and briefly flashes a console. Windows
      // children outlive the parent by default, so detached buys us nothing
      // there; keep it on POSIX where it puts the child in a new process
      // group and shields it from terminal SIGHUP.
      const child = spawn(resolvedBin, descriptor.args, {
        stdio: descriptor.stdio || ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
        cwd: effectiveCwd,
        // harnessEnv merges LAST: a per-dispatch harness model must beat the
        // per-agent extra_env baked at spawn_agent time (deepseek's
        // ANTHROPIC_MODEL — flag/env agreement, see DeepSeekCliAdapter).
        env: {
          ...baseEnv,
          // Board env_vars (ticket 354d336b) merge right after baseEnv so they
          // set non-secret config but never shadow AWB_API_KEY / cli-home /
          // per-agent credential / harness env layered on top.
          ...(spec.envVars ?? {}),
          AWB_API_KEY: effectiveApiKey,
          ...cliHomeEnv,
          ...credentialEnv,
          ...adapter.harnessEnv(harness),
        },
        shell: descriptor.shell ?? /\.(cmd|bat|ps1)$/i.test(resolvedBin),
      });
      child.once('error', (err: any) => {
        log(
          `Subagent spawn error: code=${err?.code || ''} cli=${adapter.cliType} bin=${resolvedBin} msg=${err?.message}`,
        );
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
        chat_request_id: spec.chatRequestId || null,
        ticket_id: spec.ticketId || null,
        agent_id: spec.agentId || null,
        role: spec.role || null,
        room_id: spec.roomId || null,
        started_at: Date.now(),
        expected_completion_at:
          Date.now() + (this.#config.delegation.ttlMinutes ?? 15) * 60_000,
        config_path: configPath,
        config_path_is_temp: configPathIsTemp,
        process_handle: child,
        captureOutput: !adapter.has(NATIVE_MCP),
        outLines: [],
        tailLines: [],
        commentSent: false,
        tap: null,
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
      log(`Subagent spawn error: ${err?.message ?? err}`);
      return { spawned: false, reason: 'exception' };
    }
  }

  #wireExitHandler(child: ChildProcess, pid: number): void {
    child.once('exit', async (code, signal) => {
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
      record.tap?.end({ exit_code: code, signal });

      // Answer-posting, circuit-breaker and silent-exit fallback. Extracted to
      // a named method so it can be unit-tested without forking a real child.
      await this._handleOneshotExit(record, code);

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
        const answer = this.#adapterFor(record.cli_type).collectOneshotResult(record.outLines);
        // Pass the exit code so usage/auth signatures are only fatal in a real
        // error context — a clean exit-0 answer that merely mentions 403/429/
        // quota stays a valid agent answer (won't be suppressed or trip the
        // breaker). codex's own [codex error] wrapper also counts as context.
        errClass = classifyCliError(answer, { exitCode: code });
        if (record.room_id) {
          // Chat one-shot: post the result (or a generic failure) to the room.
          // Chat replies don't feed the ticket trigger loop, so the re-trigger
          // guard below is irrelevant here — keep prior behavior.
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

    // Circuit-breaker (ticket 27806095, defect ②/③). Ticket triggers only —
    // count non-transient exits per (agent, ticket, role); open + pend when the
    // threshold is crossed, OR immediately for a non-retryable signature
    // (usage-limit / auth). A clean exit that left a real agent comment resets
    // the counter. Mirrors TicketSessionManager._onChildExit.
    if (record.kind === 'trigger' && record.ticket_id && record.agent_id) {
      const role = record.role || '';
      const cbKey = CircuitBreaker.key(record.agent_id, record.ticket_id, role);
      if (record.commentSent && code === 0) {
        this.circuitBreaker.reset(cbKey);
      } else if (!CircuitBreaker.isTransientExit(code) || errClass.nonRetryable) {
        const tail = this.#collectTail(record);
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

    // Silent-exit fallback for ticket subagents. Fires when:
    //   - exit code != 0 (subagent crashed / was killed), OR
    //   - exit code == 0 AND no comment-creating tool fired during the spawn
    //     (the "dead state" the ticket was opened against — trigger dispatched
    //     but ticket activity has zero trace of work).
    // Chat-only spawns (room_id but no ticket_id) are already covered by the
    // room_id branch above and by ChatSessionManager's fallback, so we skip
    // them here. This system-attributed comment is what the server trigger-loop
    // guard drops, so it never re-fires the loop.
    if (record.ticket_id && (!record.commentSent || code !== 0)) {
      try {
        await this.#postSilentExitFallback(record, code);
      } catch (err: any) {
        log(`Subagent silent-exit fallback failed pid=${pid}: ${err?.message ?? err}`);
      }
    }
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
          this.#scanForCommentTool(record, line);
        }
        log(`${tagFor(record)} ${line}`);
      });
    }
    if (child.stderr) {
      const rlErr = createInterface({ input: child.stderr });
      rlErr.on('line', (line) => {
        const rec = this.#map.get(pid);
        const record = rec && rec.kind !== 'reservation' ? (rec as SubagentRecord) : undefined;
        if (record) this.#bufferTail(record, line);
        log(`${tagFor(record)}[err] ${line}`);
      });
    }
  }

  /** Append a stdout/stderr line to the silent-exit tail ring. Plain-text
   *  lines are kept verbatim; stream-json events are condensed to a short
   *  prose summary (assistant text / tool_use / result subtype+error) rather
   *  than dropped — the one-shot path runs `--output-format json`, so on a
   *  failed turn the only output is a single JSON result line; dropping it
   *  left the silent-exit fallback with an empty tail (ticket ac958c06).
   *  Noise events summarize to null and are skipped. Bounded to
   *  TAIL_RING_MAX_LINES. */
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

  /** Watch parsed stream-json lines for tool_use blocks whose name is one
   *  of the comment-creating MCP tools. Marks `record.commentSent` true on
   *  the first match. Best-effort: malformed JSON / non-Claude adapters
   *  fall through silently and the silent-exit fallback still runs based
   *  on exit code alone. */
  #scanForCommentTool(record: SubagentRecord, line: string): void {
    if (record.commentSent) return;
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return;
    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (parsed?.type !== 'assistant') return;
    const content = parsed?.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue;
      for (const suffix of TICKET_COMMENT_TOOL_SUFFIXES) {
        if (block.name.endsWith(suffix)) {
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
  async #postSilentExitFallback(record: SubagentRecord, code: number | null): Promise<void> {
    const ticketId = record.ticket_id || '';
    if (!ticketId) return;
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
    await postSilentExitSystemComment(this.#config, ticketId, {
      content: body,
      exit_code: code,
      cycle_trigger_id: triggerId,
      actor_name: 'agent-manager',
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

  #sweep(): void {
    const now = Date.now();
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
        log(`Sweep: pid=${pid} exceeded TTL, sending SIGTERM`);
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
        }, SIGTERM_GRACE_MS);
      }
    }
    this.#persist();
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
      const { process_handle, outLines, tailLines, tap, ...serializable } = rec;
      void process_handle;
      void outLines;
      void tailLines;
      void tap;
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

  async stop(): Promise<void> {
    if (this.#sweepTimer) {
      clearInterval(this.#sweepTimer);
      this.#sweepTimer = null;
    }
    const pids: number[] = [];
    for (const [pid, rec] of this.#map.entries()) {
      if (rec.kind === 'reservation') continue;
      pids.push(pid);
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* dead */
      }
    }
    if (pids.length === 0) {
      this.#map.clear();
      return;
    }
    await new Promise((r) => setTimeout(r, STOP_GRACE_MS));
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    this.#map.clear();
    try {
      await fsp.writeFile(this.#persistPath, JSON.stringify({ pids: [] }, null, 2));
    } catch {
      /* best-effort */
    }
    log(`SubagentManager stopped (terminated ${pids.length} children)`);
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
}
