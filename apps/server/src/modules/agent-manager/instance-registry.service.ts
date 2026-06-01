import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { activityEvents } from '../../services/activity.service';
import { LogService } from '../../services/log.service';

/**
 * In-memory registry of plugin instances (daemon / proxy processes) currently
 * heartbeating against this server.
 *
 * One Agent row in the DB can be backed by multiple physical processes —
 * a developer running both `proxy.mjs` (Claude CLI bridge) and `daemon.mjs`
 * (standalone subagent runner) on different hosts shares one agent identity.
 * The Agent.last_seen_at field collapses that fan-out to a single boolean
 * "any process heartbeated recently?". This registry preserves the per-process
 * detail the admin UI needs: which host, which mode, which plugin version,
 * which CLI adapters are registered.
 *
 * Storage is intentionally in-process. Instance presence is high-churn and
 * ephemeral — losing it on restart is fine; the next heartbeat (≤30s by
 * default in the plugin) repopulates it. A multi-pod deployment will have
 * split-brain instance views (each pod sees only the heartbeats it received);
 * fixing that needs Redis pub/sub and isn't worth doing until AWB scales out.
 */

export interface InstanceRecord {
  instance_id: string;
  agent_id: string;
  workspace_id: string | null;
  // ST-4: 'manager' is the standalone awb-agent-manager process — it is
  // the AWB-side replacement for the plugin's daemon.mjs and supervises
  // multiple agent identities (claude/codex/antigravity).
  mode: 'daemon' | 'proxy' | 'manager';
  hostname: string;
  plugin_version: string;
  cli: string;
  cli_adapters: string[];
  pid: number;
  started_at: string;
  last_seen_at: string;
  // ST-4 manager-mode fields. Empty for daemon/proxy.
  agent_ids?: string[];        // identities the manager currently supervises
  working_dirs?: string[];     // distinct working-dir roots known to the manager
  paired_at?: string;          // ISO timestamp when the manager redeemed its pairing token
  // Per-managed-agent CLI credential snapshots (manager-mode only). One
  // entry per supervised agent the manager could read auth metadata for.
  // Older managers (pre credential-expiry telemetry) leave undefined; the
  // dashboard collapses to "no credential metadata" in that case.
  agent_credentials?: AgentCredentialEntry[];
  // Self-update fields — manager-mode only. Daemons/proxies leave undefined.
  // The manager's UpdateChecker fills these from `git fetch` + remote
  // package.json on a slow timer; older managers leave them undefined.
  latest_version?: string | null;       // version on origin/<branch>
  update_available?: boolean;           // latest > current (semver-aware)
  repo_root?: string | null;            // absolute path of the manager's git checkout
  default_branch?: string | null;       // branch the checker is tracking ('main')
  update_last_checked_at?: string | null;
  update_last_error?: string | null;
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

const INSTANCE_TTL_MS = 90_000;     // 3x default plugin heartbeat interval
const SWEEP_INTERVAL_MS = 30_000;

@Injectable()
export class InstanceRegistryService implements OnModuleDestroy {
  private readonly instances = new Map<string, InstanceRecord>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly logService: LogService) {
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
