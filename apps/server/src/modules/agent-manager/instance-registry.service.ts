import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { activityEvents } from '../../services/activity.service';
import { LogService } from '../../services/log.service';
import { MemoryMetricsRegistry } from '../../services/memory-metrics.registry';

/**
 * In-memory registry of Runtime Host processes currently heartbeating against
 * this server. Executable Agent identities never register a process directly;
 * they are represented only through their owning host's `agent_ids`.
 *
 * Storage is intentionally in-process. Instance presence is high-churn and
 * ephemeral — losing it on restart is fine; the next heartbeat (≤30s by
 * default in Agent Manager) repopulates it. A multi-pod deployment will have
 * split-brain instance views (each pod sees only the heartbeats it received);
 * fixing that needs Redis pub/sub and isn't worth doing until AWB scales out.
 */

/** 런타임이 한 권한 등급을 얼마나 충실히 표현하는가 (ticket 5851e435).
 *  agent-manager 쪽 `RuntimePermissionTierSupport` 와 같은 값 집합이다. */
export type RuntimePermissionTierSupport = 'native' | 'approximated' | 'unsupported';

export interface RuntimeCapabilityDescriptor {
  protocol: 'stream-json' | 'jsonl' | 'acp';
  session: 'oneshot' | 'persistent' | 'resumable';
  native_mcp: boolean;
  native_approvals: boolean;
  steering: boolean;
  cancellation: boolean;
  usage: 'none' | 'tokens' | 'tokens-and-cost';
  collaboration: Array<'delegated' | 'swarm'>;
  skill_delivery: Array<'prompt' | 'filesystem' | 'native'>;
  /**
   * 등급별 표현력 (ticket 5851e435). Runtime Host 가 보고하지 않는 구버전
   * 매니저에서는 undefined — 그 경우 "알 수 없음"이며, 임의의 기본값을 채워
   * 넣지 않는다(채워 넣으면 보고한 적 없는 능력을 서버가 지어내는 셈이다).
   */
  permission_tiers?: Record<'strict' | 'approve' | 'trusted', RuntimePermissionTierSupport>;
}

export interface RuntimeHealthRecord {
  installed: boolean;
  healthy: boolean;
  version: string | null;
  reason: string | null;
  capabilities: RuntimeCapabilityDescriptor;
  /** Hermes 전용: Runtime Host가 현재 열거할 수 있는 프로파일 이름 목록. */
  profiles?: string[];
}

export type RuntimeCapabilityReport = Record<string, RuntimeHealthRecord>;

/** 매니저가 보고한 argv 토큰 하나와 그 출처 (ticket 20fff298). `value` 는
 *  매니저 쪽에서 이미 마스킹된 표시용 문자열이다 — 서버는 원문을 받지 않는다. */
export interface LaunchArgEntry {
  value: string;
  /** `harness`/`effort`/`prompt` 는 **디스패치 시점** 입력이라 추정(`modes`)에는
   *  나타날 수 없고 `last_spawn` 의 실제 argv 에서만 귀속된다 (리뷰 3R). */
  source:
    | 'adapter' | 'model' | 'permission' | 'mcp' | 'session'
    | 'harness' | 'effort' | 'prompt'
    | 'runtime_profile' | 'unattributed';
  /** 실행 시점에만 정해지는 자리(프롬프트 본문, 세션 id)를 메운 값. */
  placeholder?: boolean;
}

/** spawn 경로 하나와 그 경로의 argv (ticket 20fff298). 경로가 둘이고 argv 모양이
 *  다르다 — session 은 `--session-id`/`--input-format`, oneshot 은 `--print`. */
export interface LaunchModeSpec {
  mode: 'session' | 'oneshot';
  args: LaunchArgEntry[];
  /** argv 만으로는 드러나지 않는 조건부 동작(예: 역할 고정 여부에 따라 MCP 설정
   *  출처가 갈리는 것). 매니저가 계산해 보낸 문구를 그대로 보존한다. */
  notes: string[];
}

export interface LaunchEnvEntry {
  key: string;
  /** 매니저 쪽에서 마스킹된 값. 자격증명 원문은 wire 에 오르지 않는다. */
  value: string;
  source: 'cli_home' | 'credential' | 'runtime_profile';
}

/** 실제로 spawn 된 한 번의 실행 사양 (ticket 20fff298 리뷰 2R).
 *
 *  `modes` 는 heartbeat 시점 정보만으로 만든 **추정**이라 디스패치 시점 입력
 *  (harness / 티켓 effort / 티켓별 프로파일)이 덮는 부분을 반영하지 못한다.
 *  이 필드는 spawn 사이트가 argv·env·cwd 를 확정한 직후 기록한 ground truth 다. */
export interface RecordedLaunchSpec {
  mode: 'session' | 'oneshot';
  bin: string | null;
  args: LaunchArgEntry[];
  /** 인자별 출처를 붙일 수 있었나 (리뷰 3R). false 면 모든 항목이
   *  `unattributed` 다 — "귀속 실패"와 "귀속했더니 출처 불명"은 다른 상태다. */
  args_attributed: boolean;
  cwd: string | null;
  env: LaunchEnvEntry[];
  context: {
    ticket_id: string | null;
    role: string | null;
    harness_keys: string[];
    effort: string | null;
    runtime_profile_id: string | null;
  };
  recorded_at: string;
}

/** 관리 대상 에이전트 하나의 "다음 spawn 시 실효 실행 사양" (ticket 20fff298). */
export interface AgentLaunchSpecEntry {
  agent_id: string;
  cli: string;
  bin: string | null;
  bin_error: string | null;
  /** 이 CLI 가 지원하는 spawn 경로들. **첫 항목이 기본 경로**다. */
  modes: LaunchModeSpec[];
  cwd: string | null;
  /** `'exact'` = 이 경로에서 그대로 돈다(런타임 프로파일이 고정).
   *  `'base'` = 기준 경로이고 티켓 디스패치는 그 아래 티켓별 worktree 에서 돈다. */
  cwd_kind: 'exact' | 'base';
  mcp_config_path: string | null;
  model: string | null;
  permission: { tier: string; source: string; harness_mode: string | null };
  runtime_profile: { id: string; protocol: string; model: string | null; arg_count: number } | null;
  env: LaunchEnvEntry[];
  /** 마지막 실제 spawn 사양 (ground truth). 아직 없으면 null. */
  last_spawn: RecordedLaunchSpec | null;
  varies_per_dispatch: string[];
  computed_at: string;
}

export interface InstanceRecord {
  instance_id: string;
  agent_id: string;
  workspace_id: string | null;
  mode: 'manager';
  hostname: string;
  plugin_version: string;
  cli: string;
  cli_adapters: string[];
  runtime_capabilities?: RuntimeCapabilityReport;
  pid: number;
  started_at: string;
  last_seen_at: string;
  agent_ids?: string[];        // identities the manager currently supervises
  working_dirs?: string[];     // distinct working-dir roots known to the manager
  paired_at?: string;          // ISO timestamp when the manager redeemed its pairing token
  // Per-managed-agent CLI credential snapshots (manager-mode only). One
  // entry per supervised agent the manager could read auth metadata for.
  // Older managers (pre credential-expiry telemetry) leave undefined; the
  // dashboard collapses to "no credential metadata" in that case.
  agent_credentials?: AgentCredentialEntry[];
  // 관리 대상 에이전트별 실효 실행 사양 (ticket 20fff298). REST-only 텔레메트리
  // — active_worktrees / agent_credentials 와 같은 계약이다(SSE 는 "다시 읽어라"
  // 힌트로만 쓰인다). undefined 는 **매니저가 이 필드를 아예 보고하지 않음**을,
  // `[]` 는 **보고했지만 대상 에이전트가 없음**을 뜻한다 — UI 가 "보고 안 함"과
  // "값 없음"을 구분해야 하므로 서버는 이 둘을 절대 뭉개지 않는다.
  agent_launch_specs?: AgentLaunchSpecEntry[];
  // Live worktrees + pool-lease state across the manager's supervised agents
  // (ticket 72fc244f — worktree visibility). One row per live/leased worktree
  // under each working_dir's `.awb/wt/`. Older managers leave undefined; the
  // admin "Live worktrees" panel collapses to "no worktree telemetry" then.
  // ticket_title is joined server-side (see AgentManagerController.list()), so
  // the stored record carries only ticket_id.
  active_worktrees?: WorktreeStatusEntry[];
  // manager의 `.awb/act` / `.awb/chat` 아래에 있는 라이브 Action-Run / 채팅방
  // 워크스페이스(티켓 9fd27487). active_worktrees와 동일한 presence 계약을 따른다
  // — 구버전 manager는 undefined로 남기며, 이 경우 관리자 UI는 "run-workspace
  // 텔레메트리 없음"으로 축소 표시한다.
  active_run_workspaces?: RunWorkspaceStatusEntry[];
  // Per-CLI model lists this manager's installed CLIs accept (cliType →
  // model ids), gathered via each adapter's listModels() at boot. Powers the
  // per-agent model selector in the admin UI. Older managers leave undefined.
  available_models?: Record<string, string[]>;
  // Self-update fields — Runtime Host heartbeat only.
  // The manager's UpdateChecker fills these from `git fetch` + remote
  // package.json on a slow timer; older managers leave them undefined.
  latest_version?: string | null;       // version on origin/<branch> or npm registry
  update_available?: boolean;           // latest > current (semver-aware)
  // How the manager was installed: 'npm-global' | 'unknown'. Passed through
  // verbatim (typed as string for forward-compat, and because managers predating
  // the git-mode removal still report 'git'). Drives the admin UI's Update-button
  // vs "manual updates only" decision. Undefined from managers that predate it.
  install_mode?: string | null;
  update_channel?: string | null;       // npm channel: 'latest' | dist-tag | version | 'off'
  update_last_checked_at?: string | null;
  update_last_error?: string | null;
  // ticket 9408b308 — the manager's `scheduled` update policy is asking an
  // operator to approve this exact version before it installs anything.
  // `null` = the manager reports the field but nothing is pending;
  // `undefined` = the manager predates the field entirely. Keep the two
  // apart: only a reporting manager's `null` means "the request cleared".
  update_approval_pending_version?: string | null;
  // Live count reported by the manager's in-memory circuit breaker.
  open_breaker_count?: number;
  // ticket 3d180f85 — per-reason count of dispatches suppressed by the manager's
  // provision-spanning twin guard (e.g. { inflight_dispatch: 3 }). Auto-served
  // by the GET /api/admin/agent-manager/instances `{ ...inst }` spread.
  dispatch_suppression_counts?: Record<string, number>;
  // ticket d34075b5 — per-reason count of dispatches BLOCKED at the manager's
  // worktree / push-credential preflight gate (e.g. { 'worktree:pool_exhausted': 2 }).
  // The durable, server-visible signal that a dispatch was dropped (a shared-pool
  // starvation was previously invisible until e7c87517's 24h no-progress backstop).
  // Auto-served by the GET /api/admin/agent-manager/instances `{ ...inst }` spread.
  dispatch_block_counts?: Record<string, number>;
  // ticket e299c6b3 — CLI spawn-failure telemetry. spawn_failure_count 는 부팅
  // 이후 monotonic 총계, last_spawn_error* 3종은 가장 최근의 미해소 실패를 기술한다
  // (해당 CLI 가 다시 spawn 되면 null). 관리자 대시보드 "degraded" 배지를 구동하며,
  // `{ ...inst }` spread 로 자동 serve 된다.
  spawn_failure_count?: number;
  last_spawn_error?: string | null;
  last_spawn_error_cli?: string | null;
  last_spawn_error_at?: string | null;
  // ticket c3b767c6 — dispatch-gated feature flags this manager BUILD
  // supports (e.g. 'context_window_clamp'), distinct from runtime_capabilities
  // above (which describes per-CLI-runtime health, not manager-wide dispatch
  // behavior). apps/server/src/common/manager-capability-gate.ts reads this
  // to refuse a dispatch whose profile needs a flag the manager never
  // reported, instead of spawning a session an old build would mishandle
  // silently. Older managers (pre this ticket) leave it undefined — the gate
  // treats that identically to "reported, but empty".
  manager_capabilities?: string[];
}

/**
 * Per-managed-agent credential metadata as reported on the heartbeat.
 * Mirrors the AgentCredentialEntry interface in
 * `apps/agent-manager/src/lib/instance-heartbeat.ts` — keep the two in
 * sync if the wire shape changes. Intentionally NEVER carries the raw
 * token; only derived expiry metadata.
 *
 * `kind`:
 *   - 'subscription' — per-agent OAuth credential file present.
 *   - 'api_key' — env-var auth; no expiry concept.
 *   - 'operator_home' — fallback symlink/copy of operator's HOME credential.
 *   - 'unknown' — file present but unrecognized shape.
 *   - 'missing' — no credential file on disk for this agent.
 */
export interface AgentCredentialEntry {
  agent_id: string;
  cli: string;
  kind: 'subscription' | 'api_key' | 'operator_home' | 'unknown' | 'missing';
  /** OAuth access-token expiry (Unix ms); null when not applicable. */
  expires_at_ms: number | null;
  refresh_token_present: boolean;
}

/**
 * One live worktree reported on a manager heartbeat (ticket 72fc244f). Mirrors
 * WorktreeStatusEntry in `apps/agent-manager/src/lib/instance-heartbeat.ts` —
 * keep the two in sync if the wire shape changes. `ticket_title` is NOT on the
 * wire; the server fills it by joining `ticket_id` against the ticket table when
 * serving the admin instance list.
 */
export interface WorktreeStatusEntry {
  /** The managed-agent base working_dir whose `.awb/wt/` root this sits under. */
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
  /** allocated = holding a task; idle = warm/free; orphaned = active lease with
   *  no live owner past the reclaim grace (a leak the manager's reaper reclaims). */
  state: 'allocated' | 'idle' | 'orphaned';
  /** A live worker session / subagent currently owns this worktree's ticket. */
  live: boolean;
  /** Human ticket title, joined server-side from `ticket_id`. Absent on the
   *  wire; undefined when the ticket_id is null or the ticket row is gone. */
  ticket_title?: string | null;
}

/**
 * manager heartbeat 에서 보고되는 라이브 Action-Run 또는 채팅방 워크스페이스 하나
 * (티켓 9fd27487). `apps/agent-manager/src/lib/instance-heartbeat.ts` 의
 * RunWorkspaceStatusEntry 를 그대로 미러링한다 — wire shape 이 바뀌면 두 곳을
 * 함께 동기화할 것.
 */
export interface RunWorkspaceStatusEntry {
  /** 이 경로가 속한 `.awb/act|chat/` 루트를 가진 managed-agent 의 기준 working_dir. */
  working_dir: string;
  /** 절대 경로 (`<working_dir>/.awb/act/<leaf>` 또는 `.../.awb/chat/<leaf>`). */
  path: string;
  kind: 'action' | 'chat';
  /** 마지막 경로 세그먼트 — action/room id 앞 8자리, 또는 커스텀 `workspace_folder` leaf. */
  leaf: string;
  /** 마지막으로 성공한 프로비저닝의 ISO 타임스탬프, 폴더가 liveness 마커보다 먼저 생성됐다면 null. */
  last_used_at: string | null;
  /** 지금 이 폴더 안에 라이브 프로세스가 있음을 의미한다(manager 측 `/proc` 교차 확인). */
  live: boolean;
}

const INSTANCE_TTL_MS = 90_000;     // 3x default manager heartbeat interval
const SWEEP_INTERVAL_MS = 30_000;

@Injectable()
export class InstanceRegistryService implements OnModuleDestroy {
  private readonly instances = new Map<string, InstanceRecord>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly logService: LogService,
    metrics: MemoryMetricsRegistry,
  ) {
    metrics.register('agentManager.instances', () => this.instances.size);
    this.timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    if (this.timer && typeof (this.timer as any).unref === 'function') {
      (this.timer as any).unref();
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  upsert(input: Omit<InstanceRecord, 'last_seen_at'>): InstanceRecord {
    const now = new Date().toISOString();
    const existed = this.instances.has(input.instance_id);

    // A manager restart intentionally creates a fresh instance_id. The old
    // process cannot still be legitimate on the same host/identity because the
    // manager lockfile enforces one owner. Remove that predecessor immediately
    // instead of rendering its old version beside the replacement for the
    // entire 90-second TTL window (which makes successful self-updates look
    // failed in the admin UI).
    if (!existed && input.mode === 'manager') {
      for (const [id, previous] of this.instances) {
        if (
          id !== input.instance_id &&
          previous.mode === 'manager' &&
          previous.agent_id === input.agent_id &&
          previous.hostname === input.hostname
        ) {
          this.instances.delete(id);
          activityEvents.emit('agent_instance_update', {
            action: 'removed',
            instance: previous,
            timestamp: now,
          });
          this.logService.debug(
            'AgentManager',
            `Superseded restarted manager instance ${id.slice(0, 8)} with ${input.instance_id.slice(0, 8)}`,
          );
        }
      }
    }

    const rec: InstanceRecord = { ...input, last_seen_at: now };
    this.instances.set(input.instance_id, rec);
    activityEvents.emit('agent_instance_update', {
      action: existed ? 'updated' : 'registered',
      instance: rec,
      timestamp: now,
    });
    return rec;
  }

  list(): InstanceRecord[] {
    return Array.from(this.instances.values()).sort((a, b) => {
      if (a.hostname !== b.hostname) return a.hostname.localeCompare(b.hostname);
      return a.started_at.localeCompare(b.started_at);
    });
  }

  listForWorkspace(workspaceId: string): InstanceRecord[] {
    return this.list().filter((i) => i.workspace_id === workspaceId);
  }

  /** Live instances currently supervising `agentId` (ticket c3b767c6 —
   *  dispatch-capability gate). Usually one; an agent identity backed by more
   *  than one physical process (e.g. laptop + VM sharing a pairing code)
   *  returns each. TTL-swept like every other view onto `instances`.
   *
   *  Matches on EITHER field because both wire shapes are live:
   *  - `agent_id === agentId`: the common single-agent-per-host pairing —
   *    the manager's own paired identity IS the dispatched-to agent.
   *  - `agent_ids?.includes(agentId)`: a host supervising OTHER agent
   *    identities it spawned (ST-5b multi-agent supervision) — those never
   *    register as `agent_id` themselves, only through this list. Checking
   *    `agent_id` alone here always returns `[]` for that case, silently
   *    routing every capability check through the zero-instance fail-open
   *    branch (ticket c3b767c6 review — the exact defect this fixes). */
  listForAgent(agentId: string): InstanceRecord[] {
    return this.list().filter((i) => i.agent_id === agentId || i.agent_ids?.includes(agentId));
  }

  get(instanceId: string): InstanceRecord | null {
    return this.instances.get(instanceId) ?? null;
  }

  remove(instanceId: string): boolean {
    const rec = this.instances.get(instanceId);
    if (!rec) return false;
    this.instances.delete(instanceId);
    activityEvents.emit('agent_instance_update', {
      action: 'removed',
      instance: rec,
      timestamp: new Date().toISOString(),
    });
    return true;
  }

  private sweep(): void {
    const now = Date.now();
    let removed = 0;
    for (const [id, rec] of this.instances) {
      if (now - new Date(rec.last_seen_at).getTime() > INSTANCE_TTL_MS) {
        this.instances.delete(id);
        activityEvents.emit('agent_instance_update', {
          action: 'removed',
          instance: rec,
          timestamp: new Date().toISOString(),
        });
        removed++;
      }
    }
    if (removed > 0) {
      this.logService.debug('AgentManager', `Swept ${removed} stale instance(s)`);
    }
  }
}
