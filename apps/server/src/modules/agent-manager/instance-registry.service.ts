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
  // multiple agent identities (claude/codex/gemini).
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
  // Self-update metadata reported by manager-mode instances.
  // `latest_version` = newest version visible in the manager's git remote
  // (read from `apps/agent-manager/package.json` on the upstream tracked
  // branch). `update_available` = strict comparison of plugin_version <
  // latest_version using a lex/semver-ish tuple. `repo_root` = the local
  // git checkout the manager would update from. All three undefined for
  // daemon/proxy or for managers whose upstream probe hasn't completed.
  latest_version?: string;
  update_available?: boolean;
  repo_root?: string;
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
