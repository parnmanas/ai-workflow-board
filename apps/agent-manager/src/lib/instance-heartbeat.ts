// Periodically POST per-process metadata to AWB so the admin
// the AI Agents runtime section can render every running agent-manager.
//
// PresenceHeartbeat already stamps Agent.last_seen_at, but that flag collapses
// every running process for one agent down to a single bit. This heartbeat
// preserves the per-process fan-out the dashboard needs:
//
//   - mode             literal 'manager'
//   - hostname         os.hostname()
//   - plugin_version   manager package version (legacy wire-field name)
//   - cli              the adapter we booted with (claude, antigravity, …)
//   - cli_adapters     all known adapters this binary exposes
//   - pid              process pid
//   - started_at       boot time of the process (set once)
//
// Cadence: same 30s clock as PresenceHeartbeat. Server's TTL is 90s.

import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { HEARTBEAT_INTERVAL_MS, REQUEST_TIMEOUT_MS } from './constants.js';
import { log } from './logging.js';
import type { AwbConfig } from './rest.js';
import type { UpdateChecker } from './self-update.js';
import type { SpawnFailureSnapshot } from './spawn-failure-tracker.js';
import type { RuntimeCapabilityReport } from './runtime/runtime-health.js';

export type InstanceMode = 'manager';

export interface InstanceMeta {
  mode: InstanceMode;
  version: string;
  cli: string;
  cliAdapters: string[];
  // Full registered-runtime health snapshot captured once at boot. Unlike the
  // deprecated cli_adapters projection, this distinguishes missing, unhealthy,
  // and healthy runtimes and includes the harness capability contract.
  runtimeCapabilities?: RuntimeCapabilityReport | null;
  // ticket c3b767c6 — flat list of dispatch-gated feature flags this BUILD
  // supports (e.g. runtime-profiles.ts MANAGER_CAPABILITIES), unrelated to
  // per-CLI-runtime health above: this describes what the manager binary
  // itself implements regardless of which CLI a given session uses. The
  // server refuses to dispatch a profile that needs a flag this manager
  // never reports, instead of spawning a session an old build would
  // mishandle silently. Optional so callers that don't pass one still
  // construct a valid heartbeat (an empty list, same as omitting it).
  managerCapabilities?: string[] | null;
  // Per-CLI model enumeration captured once at boot (cliType → model ids),
  // via each adapter's listModels(). Shipped verbatim on every heartbeat as
  // `available_models` so AWB can populate a per-agent model selector from the
  // CLIs actually installed on this host. Optional so callers that don't
  // gather models still build a valid heartbeat.
  availableModels?: Record<string, string[]> | null;
  // ST-5b — managed-agent presence reporter. Optional so legacy callers
  // that don't track managed agents still construct a valid heartbeat.
  managedAgents?: ManagedAgentSnapshot | null;
  // Self-update tracker; included in every heartbeat so the admin UI can
  // render `current → latest` + an Update button without polling another
  // endpoint. Optional so harnesses that opt out of auto-update still
  // construct a valid heartbeat.
  updateChecker?: UpdateChecker | null;
  // Per-tick provider that returns one entry per supervised managed
  // agent describing its CLI auth state — auth mode, OAuth access-token
  // expiry, refresh_token presence. Async so adapters can do disk I/O
  // (read `<cli-home>/.credentials.json` etc.) without blocking the
  // payload factory. Errors must NOT throw; the provider is best-effort.
  // Returning [] (or omitting the provider entirely) skips the field;
  // older AWB servers ignore it, newer ones render expiry badges.
  agentCredentialMetaProvider?: AgentCredentialMetaProvider | null;
  // Per-tick provider that enumerates the manager's live worktrees + pool-lease
  // state (ticket 72fc244f). Best-effort/async like the credential provider —
  // errors are swallowed and the field is skipped. Returning [] (or omitting it)
  // means older servers see no change; newer ones render the "Live worktrees"
  // panel with the shared slot→task mapping.
  worktreeStatusProvider?: WorktreeStatusProvider | null;
  // 매니저가 파악 중인 Action-Run / 채팅방 작업폴더(`.awb/act` / `.awb/chat`
  // 아래)를 매 tick마다 열거하는 provider (ticket 9fd27487). worktreeStatusProvider와
  // 동일한 best-effort 계약 — 에러는 삼켜지고, []를 반환하거나(혹은 아예
  // 생략하면) 필드를 건너뛴다.
  runWorkspaceStatusProvider?: RunWorkspaceStatusProvider | null;
  // Per-tick count of currently-open dispatch circuit breakers. Kept as a
  // provider so the heartbeat always reflects the live in-memory state.
  openBreakerCountProvider?: (() => number) | null;
  // ticket 3d180f85 — per-reason count of dispatches suppressed by the
  // provision-spanning twin guard (e.g. { inflight_dispatch: 3 }). Provider so
  // the heartbeat reflects live in-memory counts, like openBreakerCountProvider.
  dispatchSuppressionCountsProvider?: (() => Record<string, number>) | null;
  // ticket d34075b5 — per-reason count of dispatches BLOCKED at the worktree /
  // push-credential preflight gate (e.g. { 'worktree:pool_exhausted': 2 }). The
  // durable, server-visible signal for a dropped dispatch. Provider so the
  // heartbeat reflects live in-memory counts, like dispatchSuppressionCountsProvider.
  dispatchBlockCountsProvider?: (() => Record<string, number>) | null;
  // 매 tick 의 CLI spawn-failure 요약(ticket e299c6b3). provider 라서 heartbeat 이
  // 항상 live in-memory 상태를 반영한다. CLI 가 실행 못 할 때(예: 해소 안 된
  // Windows `.cmd` shim 의 codex ENOENT) 관리자 대시보드에 "degraded" 배지를
  // 렌더하는 REST-only additive 필드.
  spawnFailureProvider?: (() => SpawnFailureSnapshot) | null;
  // ticket 23753dc7 — 하트비트 POST 가 처음 성공했을 때 한 번 불린다. 자가
  // 업데이트의 부팅 성공 판정 기준이 정확히 "재기동 후 하트비트 1회 성공"이라
  // (정책 C), 그 사실을 아는 유일한 지점이 여기다. best-effort: 콜백이 던져도
  // 하트비트는 계속 돈다.
  onFirstPostSuccess?: (() => void) | null;
}

/** Tiny duck-typed read-only snapshot of ManagedAgentRegistry. */
export interface ManagedAgentSnapshot {
  liveAgentIds(): string[];
  workingDirs(): string[];
}

/** One row per supervised managed agent. The fields here are derived
 *  metadata only — the raw token never leaves the manager host. The
 *  `agent_id` lets AWB join with the Agent.id it already knows. */
export interface AgentCredentialEntry {
  agent_id: string;
  cli: string;
  /** Auth mode at heartbeat time. 'subscription' / 'api_key' / 'operator_home'
   *  come from spawn-time decisions; 'unknown' / 'missing' come from the
   *  on-disk read result (file shape unrecognized / file absent). */
  kind: 'subscription' | 'api_key' | 'operator_home' | 'unknown' | 'missing';
  /** OAuth access-token expiry (Unix ms). null when the kind doesn't
   *  carry an expiry concept (api_key) or the file couldn't be read. */
  expires_at_ms: number | null;
  /** True when an OAuth refresh_token is present and the access token
   *  can auto-renew silently. False / api_key flagging indicates that
   *  any expiry is silent failure waiting to happen. */
  refresh_token_present: boolean;
}

export type AgentCredentialMetaProvider = () => Promise<AgentCredentialEntry[]>;

/** One live worktree the manager currently knows about, for the admin
 *  "Live worktrees" view (ticket 72fc244f). Mirrors WorktreeSnapshotEntry in
 *  worktree-manager.ts but flattened to snake_case wire keys and tagged with the
 *  managed-agent working_dir it belongs to. The server joins `ticket_id` to the
 *  ticket table to add a human title. QA/Security run clones (`.awb/qa/`) are not
 *  worktrees of the repo and never appear here. */
export interface WorktreeStatusEntry {
  /** The managed-agent base working_dir this worktree's `.awb/wt/` root sits under. */
  working_dir: string;
  /** Absolute worktree path (`<working_dir>/.awb/wt/<slot>`). */
  path: string;
  /** Last path segment: `shared-<i>` (shared pool slot) or `<ticket8>` (per_ticket). */
  slot: string;
  mode: 'shared' | 'per_ticket';
  /** Full ticket uuid when known (shared active lease / live per_ticket), else null. */
  ticket_id: string | null;
  /** Current branch; null when detached / at base HEAD. */
  branch: string | null;
  /** allocated = holding a task; idle = warm/free; orphaned = active lease, no
   *  live owner, past reclaim grace (a leak the reaper will reclaim). */
  state: 'allocated' | 'idle' | 'orphaned';
  /** A live worker session / subagent currently owns this worktree's ticket. */
  live: boolean;
}

/** Per-tick provider that enumerates live worktrees across every supervised
 *  managed agent. Async (shells `git worktree list` per working_dir) and
 *  best-effort — must never throw; returning [] skips the heartbeat field. */
export type WorktreeStatusProvider = () => Promise<WorktreeStatusEntry[]>;

/** 매니저가 현재 파악하고 있는 살아있는 Action-Run 또는 채팅방 작업폴더 하나
 *  (ticket 9fd27487) — 관리자용 "Run workspaces" 화면에 쓰인다. worktree-manager.ts의
 *  RunWorkspaceSnapshotEntry를 그대로 미러링하되 snake_case wire 키로 평탄화하고,
 *  자신이 속한 managed-agent 의 working_dir 를 태그로 붙인다 — WorktreeStatusEntry와
 *  동일한 형태 관례다. worktree와 달리 이들은 평범한 디렉터리일 뿐이다(branch 없음,
 *  pool lease 없음, `git worktree list` 항목도 없음). */
export interface RunWorkspaceStatusEntry {
  /** 이 작업폴더의 `.awb/act|chat/` 루트가 속한 managed-agent 기준 working_dir. */
  working_dir: string;
  /** 절대경로 (`<working_dir>/.awb/act/<leaf>`, `.../.awb/chat/<leaf>`, 또는 `.../.awb/orch/<leaf>`). */
  path: string;
  kind: 'action' | 'chat' | 'orchestration';
  /** 경로 마지막 세그먼트 — action/room id 의 앞 8자리, 또는 커스텀 `workspace_folder` leaf. */
  leaf: string;
  /** 마지막으로 성공한 provision 의 ISO 타임스탬프. liveness 마커보다 먼저 있던 폴더라면 null. */
  last_used_at: string | null;
  /** 현재 이 폴더 안에 살아있는 프로세스가 있음을 나타낸다(`/proc` cross-check). */
  live: boolean;
}

/** 감독 중인 모든 managed agent 전체에서 살아있는 Action-Run / 채팅방 작업폴더를
 *  매 tick마다 열거하는 provider (ticket 9fd27487). WorktreeStatusProvider와 동일한
 *  async / best-effort 계약을 따른다. */
export type RunWorkspaceStatusProvider = () => Promise<RunWorkspaceStatusEntry[]>;

export interface InstanceHeartbeatPayload {
  instance_id: string;
  agent_id: string | null;
  workspace_id: string | null;
  mode: InstanceMode;
  hostname: string;
  plugin_version: string;
  cli: string;
  cli_adapters: string[];
  runtime_capabilities?: RuntimeCapabilityReport;
  // ticket c3b767c6 — dispatch-gated feature flags this build supports (see
  // InstanceMeta.managerCapabilities doc comment above). Omitted (rather than
  // sent as []) when empty so an old AWB server's whole-record replace on
  // upsert doesn't matter either way, and so the field's mere presence never
  // implies "this build knows about capability reporting" when it actually
  // has nothing to declare.
  manager_capabilities?: string[];
  pid: number;
  started_at: string;
  // cliType → model ids each installed CLI accepts. Gathered once at boot.
  // Older AWB servers ignore it; newer ones expose it for the model selector.
  available_models?: Record<string, string[]>;
  // ST-4 — populated when InstanceMeta carries a managedAgents snapshot.
  agent_ids?: string[];
  working_dirs?: string[];
  paired_at?: string;
  // Per-managed-agent CLI credential snapshots — one row per supervised
  // agent, only when the heartbeat factory was given a provider. See
  // AgentCredentialEntry for the field semantics.
  agent_credentials?: AgentCredentialEntry[];
  // Live worktrees + pool-lease state across all supervised agents (ticket
  // 72fc244f). Only present when the worktree provider is wired and returns
  // rows. Older AWB servers ignore it; newer ones render the "Live worktrees"
  // panel with the shared slot→task mapping.
  active_worktrees?: WorktreeStatusEntry[];
  // 살아있는 Action-Run / 채팅방 작업폴더 목록 (ticket 9fd27487). active_worktrees와
  // 동일한 presence 계약 — provider 가 배선되어 있고 row 를 반환할 때만 설정된다.
  // 이전 버전 AWB 서버는 이 필드를 무시한다.
  active_run_workspaces?: RunWorkspaceStatusEntry[];
  // Self-update fields — populated when InstanceMeta carries an UpdateChecker.
  // Older AWB servers ignore them; newer ones surface them on the admin UI.
  latest_version?: string | null;
  update_available?: boolean;
  // Install mode ('npm-global' | 'unknown') — lets the admin UI show a working
  // Update button for npm-global installs instead of "manual updates only".
  // Older managers omit it, or report the retired 'git' mode; either way the UI
  // falls back to "manual updates only".
  install_mode?: string | null;
  // Active npm update channel ('latest', a dist-tag, an exact version, or 'off'
  // when the operator pinned this build). Undefined from managers predating it.
  update_channel?: string | null;
  update_last_checked_at?: string | null;
  update_last_error?: string | null;
  open_breaker_count?: number;
  // ticket 3d180f85 — per-reason dispatch-suppression counts from the
  // provision-spanning twin guard. Omitted when nothing was suppressed.
  dispatch_suppression_counts?: Record<string, number>;
  // ticket d34075b5 — per-reason dispatch-BLOCK counts from the worktree /
  // push-credential preflight gate (incl. shared-pool 'worktree:pool_exhausted').
  // Omitted when nothing has been blocked.
  dispatch_block_counts?: Record<string, number>;
  // ticket e299c6b3 — CLI spawn-failure telemetry(REST-only, open_breaker_count
  // 과 동일 방식). spawn_failure_count 는 부팅 이후 monotonic 총계이고,
  // last_spawn_error* 3종은 가장 최근의 미해소 실패를 기술하며 해당 CLI 가 다시
  // 정상 spawn 되면 null 로 지워진다.
  spawn_failure_count?: number;
  last_spawn_error?: string | null;
  last_spawn_error_cli?: string | null;
  last_spawn_error_at?: string | null;
}

export class InstanceHeartbeat {
  #config: AwbConfig;
  #agentId: string | null;
  #payloadFactory: () => Promise<InstanceHeartbeatPayload>;
  #instanceId: string;
  #startedAt: string;
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;
  /** 첫 성공 POST 에서 한 번만 불리는 콜백 (ticket 23753dc7). */
  #onFirstPostSuccess: (() => void) | null = null;

  constructor(config: AwbConfig, agentId: string | null, meta: InstanceMeta) {
    this.#config = config;
    this.#agentId = agentId;
    this.#onFirstPostSuccess = meta?.onFirstPostSuccess ?? null;
    this.#instanceId = randomUUID();
    this.#startedAt = new Date().toISOString();
    const cliAdapters = Array.isArray(meta?.cliAdapters)
      ? meta.cliAdapters.map((s) => String(s)).filter(Boolean)
      : [];
    const managedSnapshot = meta?.managedAgents ?? null;
    const availableModels =
      meta?.availableModels && typeof meta.availableModels === 'object'
        ? meta.availableModels
        : null;
    const runtimeCapabilities =
      meta?.runtimeCapabilities && typeof meta.runtimeCapabilities === 'object'
        ? meta.runtimeCapabilities
        : null;
    const managerCapabilities = Array.isArray(meta?.managerCapabilities)
      ? meta.managerCapabilities.map((s) => String(s)).filter(Boolean)
      : [];
    const updateChecker = meta?.updateChecker ?? null;
    const credentialMetaProvider = meta?.agentCredentialMetaProvider ?? null;
    const worktreeStatusProvider = meta?.worktreeStatusProvider ?? null;
    const runWorkspaceStatusProvider = meta?.runWorkspaceStatusProvider ?? null;
    const openBreakerCountProvider = meta?.openBreakerCountProvider ?? null;
    const dispatchSuppressionCountsProvider = meta?.dispatchSuppressionCountsProvider ?? null;
    const dispatchBlockCountsProvider = meta?.dispatchBlockCountsProvider ?? null;
    const spawnFailureProvider = meta?.spawnFailureProvider ?? null;
    this.#payloadFactory = async () => {
      const agentIds = managedSnapshot ? managedSnapshot.liveAgentIds() : [];
      const workingDirs = managedSnapshot ? managedSnapshot.workingDirs() : [];
      const updateStatus = updateChecker ? updateChecker.status() : null;
      let openBreakerCount = 0;
      try {
        openBreakerCount = Math.max(0, Math.trunc(openBreakerCountProvider?.() ?? 0));
      } catch (err: any) {
        log(`Instance heartbeat: open-breaker provider failed: ${err?.message ?? err}`);
      }
      // Best-effort like the breaker count: a throwing provider must never
      // wedge the heartbeat. Coerce to a clean {reason: non-negative-int} map.
      let dispatchSuppressionCounts: Record<string, number> = {};
      try {
        const raw = dispatchSuppressionCountsProvider?.() ?? {};
        for (const [reason, n] of Object.entries(raw)) {
          const v = Math.max(0, Math.trunc(Number(n) || 0));
          if (v > 0) dispatchSuppressionCounts[reason] = v;
        }
      } catch (err: any) {
        log(`Instance heartbeat: dispatch-suppression provider failed: ${err?.message ?? err}`);
        dispatchSuppressionCounts = {};
      }
      // Same best-effort contract for the dispatch-BLOCK counter (ticket d34075b5).
      let dispatchBlockCounts: Record<string, number> = {};
      try {
        const raw = dispatchBlockCountsProvider?.() ?? {};
        for (const [reason, n] of Object.entries(raw)) {
          const v = Math.max(0, Math.trunc(Number(n) || 0));
          if (v > 0) dispatchBlockCounts[reason] = v;
        }
      } catch (err: any) {
        log(`Instance heartbeat: dispatch-block provider failed: ${err?.message ?? err}`);
        dispatchBlockCounts = {};
      }
      // 같은 best-effort 계약: throw 하는 spawn-failure provider 도 heartbeat 을
      // 절대 막지 못한다. null snapshot 은 필드를 스킵하고(구 서버는 어차피 무시),
      // 유효하면 count 포함해 항상 실어 보낸다.
      let spawnFailure: SpawnFailureSnapshot | null = null;
      if (spawnFailureProvider) {
        try {
          spawnFailure = spawnFailureProvider();
        } catch (err: any) {
          log(`Instance heartbeat: spawn-failure provider failed: ${err?.message ?? err}`);
          spawnFailure = null;
        }
      }
      // Best-effort: a provider that throws should never wedge the
      // heartbeat. Treat any failure as "no credentials this tick" and
      // let the next tick try again — the field is purely informational.
      let agentCredentials: AgentCredentialEntry[] = [];
      if (credentialMetaProvider) {
        try {
          agentCredentials = await credentialMetaProvider();
        } catch (err: any) {
          log(`Instance heartbeat: credential-meta provider failed: ${err?.message ?? err}`);
          agentCredentials = [];
        }
      }
      // Same best-effort contract: a throwing worktree provider must never wedge
      // the heartbeat — treat failure as "no worktrees this tick".
      let activeWorktrees: WorktreeStatusEntry[] = [];
      if (worktreeStatusProvider) {
        try {
          activeWorktrees = await worktreeStatusProvider();
        } catch (err: any) {
          log(`Instance heartbeat: worktree-status provider failed: ${err?.message ?? err}`);
          activeWorktrees = [];
        }
      }
      // 동일한 best-effort 계약: run-workspace provider 가 throw 하더라도 heartbeat 이
      // 절대 wedge 되어서는 안 된다 — 실패는 "이번 tick 에는 run workspace 없음"으로 취급한다.
      let activeRunWorkspaces: RunWorkspaceStatusEntry[] = [];
      if (runWorkspaceStatusProvider) {
        try {
          activeRunWorkspaces = await runWorkspaceStatusProvider();
        } catch (err: any) {
          log(`Instance heartbeat: run-workspace-status provider failed: ${err?.message ?? err}`);
          activeRunWorkspaces = [];
        }
      }
      return {
        instance_id: this.#instanceId,
        agent_id: this.#agentId,
        workspace_id: (config?.workspace_id as string) || null,
        mode: meta?.mode === 'manager' ? 'manager' : 'manager',
        hostname: hostname() || 'unknown',
        plugin_version: String(meta?.version || 'unknown'),
        cli: String(meta?.cli || 'claude'),
        cli_adapters: cliAdapters,
        ...(runtimeCapabilities ? { runtime_capabilities: runtimeCapabilities } : {}),
        ...(managerCapabilities.length ? { manager_capabilities: managerCapabilities } : {}),
        pid: process.pid,
        started_at: this.#startedAt,
        // Only include the managed-agent fields when the snapshot is wired
        // and non-empty; legacy AWB servers (pre-ST-4) don't expect them.
        ...(agentIds.length ? { agent_ids: agentIds } : {}),
        ...(workingDirs.length ? { working_dirs: workingDirs } : {}),
        ...(availableModels && Object.keys(availableModels).length
          ? { available_models: availableModels }
          : {}),
        ...(agentCredentials.length ? { agent_credentials: agentCredentials } : {}),
        ...(activeWorktrees.length ? { active_worktrees: activeWorktrees } : {}),
        ...(activeRunWorkspaces.length ? { active_run_workspaces: activeRunWorkspaces } : {}),
        ...(openBreakerCountProvider ? { open_breaker_count: openBreakerCount } : {}),
        ...(dispatchSuppressionCountsProvider && Object.keys(dispatchSuppressionCounts).length > 0
          ? { dispatch_suppression_counts: dispatchSuppressionCounts }
          : {}),
        ...(dispatchBlockCountsProvider && Object.keys(dispatchBlockCounts).length > 0
          ? { dispatch_block_counts: dispatchBlockCounts }
          : {}),
        ...(spawnFailure
          ? {
              spawn_failure_count: spawnFailure.spawn_failure_count,
              last_spawn_error: spawnFailure.last_spawn_error,
              last_spawn_error_cli: spawnFailure.last_spawn_error_cli,
              last_spawn_error_at: spawnFailure.last_spawn_error_at,
            }
          : {}),
        ...(updateStatus
          ? {
              latest_version: updateStatus.latest_version,
              update_available: updateStatus.update_available,
              install_mode: updateStatus.install_mode,
              update_channel: updateStatus.update_channel,
              update_last_checked_at: updateStatus.last_checked_at,
              update_last_error: updateStatus.last_error,
            }
          : {}),
      };
    };
  }

  start(): void {
    if (!this.#agentId) {
      log('Instance heartbeat skipped — agent_id not in agent.json (run pairing first)');
      return;
    }
    this.#stopped = false;
    this.#post().catch((err) =>
      log(`Instance heartbeat (initial) failed: ${err?.message ?? err}`),
    );
    this.#timer = setInterval(() => {
      this.#post().catch((err) =>
        log(`Instance heartbeat failed: ${err?.message ?? err}`),
      );
    }, HEARTBEAT_INTERVAL_MS);
    this.#timer.unref?.();
    log(`Instance heartbeat started (instance=${this.#instanceId.slice(0, 8)}…)`);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  get instanceId(): string {
    return this.#instanceId;
  }

  async #post(): Promise<void> {
    if (this.#stopped) return;
    const payload = await this.#payloadFactory();
    if (!payload.agent_id) return;
    const url = `${this.#config.url.replace(/\/$/, '')}/api/agent/instance-heartbeat`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Agent-Key': this.#config.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) {
      // 404 expected on older AWB servers — keep noise low.
      // 구버전 서버라 엔드포인트가 없는 것뿐이므로 "매니저가 부팅해 서버까지
      // 말을 걸었다"는 사실은 성립한다 — 부팅 검증에는 성공으로 친다.
      if (resp.status === 404) {
        this.#notifyFirstSuccess();
        return;
      }
      throw new Error(`POST /api/agent/instance-heartbeat HTTP ${resp.status}`);
    }
    await resp.text().catch(() => null);
    this.#notifyFirstSuccess();
  }

  /** 첫 성공에서만 콜백을 부르고 참조를 버린다(이후 tick 은 비용 0). */
  #notifyFirstSuccess(): void {
    const cb = this.#onFirstPostSuccess;
    if (!cb) return;
    this.#onFirstPostSuccess = null;
    try {
      cb();
    } catch (err: any) {
      log(`Instance heartbeat: boot-verification callback failed: ${err?.message ?? err}`);
    }
  }
}
