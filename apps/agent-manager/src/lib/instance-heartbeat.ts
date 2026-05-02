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
//   - cli              the adapter we booted with (claude, gemini, …)
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

export type InstanceMode = 'manager';

export interface InstanceMeta {
  mode: InstanceMode;
  version: string;
  cli: string;
  cliAdapters: string[];
  // ST-5b — managed-agent presence reporter. Optional so legacy callers
  // that don't track managed agents still construct a valid heartbeat.
  managedAgents?: ManagedAgentSnapshot | null;
}

/** Tiny duck-typed read-only snapshot of ManagedAgentRegistry. */
export interface ManagedAgentSnapshot {
  liveAgentIds(): string[];
  workingDirs(): string[];
}

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
  // ST-4 — populated when InstanceMeta carries a managedAgents snapshot.
  agent_ids?: string[];
  working_dirs?: string[];
  paired_at?: string;
}

export class InstanceHeartbeat {
  #config: AwbConfig;
  #agentId: string | null;
  #payloadFactory: () => InstanceHeartbeatPayload;
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
    this.#payloadFactory = () => {
      const agentIds = managedSnapshot ? managedSnapshot.liveAgentIds() : [];
      const workingDirs = managedSnapshot ? managedSnapshot.workingDirs() : [];
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
    const payload = this.#payloadFactory();
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
