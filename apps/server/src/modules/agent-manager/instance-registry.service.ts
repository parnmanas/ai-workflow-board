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
   *  returns each. TTL-swept like every other view onto `instances`. */
  listForAgent(agentId: string): InstanceRecord[] {
    return this.list().filter((i) => i.agent_id === agentId);
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
