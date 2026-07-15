// Periodically POST per-process metadata to AWB so the admin
// `/admin/agent-manager` page can render every running agent-manager.
//
// PresenceHeartbeat already stamps Agent.last_seen_at, but that flag collapses
// every running process for one agent down to a single bit. This heartbeat
// preserves the per-process fan-out the dashboard needs:
//
//   - mode             literal 'manager' (was daemon|proxy in claude-plugin)
//   - hostname         os.hostname()
//   - plugin_version   read from caller (package.json version)
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

export type InstanceMode = 'manager';

export interface InstanceMeta {
  mode: InstanceMode;
  version: string;
  cli: string;
  cliAdapters: string[];
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
  // Per-tick count of currently-open dispatch circuit breakers. Kept as a
  // provider so the heartbeat always reflects the live in-memory state.
  openBreakerCountProvider?: (() => number) | null;
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

export interface InstanceHeartbeatPayload {
  instance_id: string;
  agent_id: string | null;
  workspace_id: string | null;
  mode: InstanceMode;
  hostname: string;
  plugin_version: string;
  cli: string;
  cli_adapters: string[];
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
  // Self-update fields — populated when InstanceMeta carries an UpdateChecker.
  // Older AWB servers ignore them; newer ones surface them on the admin UI.
  latest_version?: string | null;
  update_available?: boolean;
  // Install mode ('git' | 'npm-global' | 'unknown') — lets the admin UI show a
  // working Update button for npm-global installs instead of "manual updates
  // only". Older managers omit it; the server/UI degrade to the repo_root check.
  install_mode?: string | null;
  repo_root?: string | null;
  default_branch?: string | null;
  update_last_checked_at?: string | null;
  update_last_error?: string | null;
  open_breaker_count?: number;
}

export class InstanceHeartbeat {
  #config: AwbConfig;
  #agentId: string | null;
  #payloadFactory: () => Promise<InstanceHeartbeatPayload>;
  #instanceId: string;
  #startedAt: string;
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;

  constructor(config: AwbConfig, agentId: string | null, meta: InstanceMeta) {
    this.#config = config;
    this.#agentId = agentId;
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
    const updateChecker = meta?.updateChecker ?? null;
    const credentialMetaProvider = meta?.agentCredentialMetaProvider ?? null;
    const worktreeStatusProvider = meta?.worktreeStatusProvider ?? null;
    const openBreakerCountProvider = meta?.openBreakerCountProvider ?? null;
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
      return {
        instance_id: this.#instanceId,
        agent_id: this.#agentId,
        workspace_id: (config?.workspace_id as string) || null,
        mode: meta?.mode === 'manager' ? 'manager' : 'manager',
        hostname: hostname() || 'unknown',
        plugin_version: String(meta?.version || 'unknown'),
        cli: String(meta?.cli || 'claude'),
        cli_adapters: cliAdapters,
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
        ...(openBreakerCountProvider ? { open_breaker_count: openBreakerCount } : {}),
        ...(updateStatus
          ? {
              latest_version: updateStatus.latest_version,
              update_available: updateStatus.update_available,
              install_mode: updateStatus.install_mode,
              repo_root: updateStatus.repo_root,
              default_branch: updateStatus.branch,
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
      if (resp.status === 404) return;
      throw new Error(`POST /api/agent/instance-heartbeat HTTP ${resp.status}`);
    }
    await resp.text().catch(() => null);
  }
}
