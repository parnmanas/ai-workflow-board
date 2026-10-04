import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { LogService } from '../../services/log.service';

const OFFLINE_THRESHOLD_MS = 60_000; // 60s = 2 missed heartbeats at 30s interval
const SWEEP_INTERVAL_MS = 30_000;    // sweep every 30s

// The ticket-lock sweep (locked_by_agent_id / locked_at TTL) is gone: tickets
// have no locks any more — one assignee owns a ticket (docs/tickets.md).

@Injectable()
export class AgentConnectionService implements OnModuleInit, OnModuleDestroy {
  private offlineSweepHandle: NodeJS.Timeout | null = null;

  constructor(
    private readonly logService: LogService,
  ) {}

  onModuleInit() {
    this.offlineSweepHandle = setInterval(async () => {
      const count = await this.sweepOfflineAgents(OFFLINE_THRESHOLD_MS);
      if (count > 0) {
        this.logService.info('MCP', `Swept ${count} agent(s) offline (heartbeat timeout)`);
      }
    }, SWEEP_INTERVAL_MS);

    // Don't let this housekeeping sweep keep the Node event loop alive; the
    // server lifecycle owns process exit. (Guarded for fake timers in tests.)
    this.offlineSweepHandle.unref?.();
  }

  onModuleDestroy() {
    if (this.offlineSweepHandle) {
      clearInterval(this.offlineSweepHandle);
      this.offlineSweepHandle = null;
    }
  }

  /**
   * Mark a single agent offline when their MCP transport closes — but only if
   * last_seen_at is already stale. This avoids flapping when Claude CLI (and
   * other Streamable HTTP clients) create per-request sessions that DELETE
   * immediately after a successful ping, which would otherwise overwrite the
   * is_online=1 written by the ping tool milliseconds earlier.
   *
   * Offline detection for truly disconnected agents is still handled by the
   * 30s sweepOfflineAgents interval using the same OFFLINE_THRESHOLD_MS.
   */
  // P4c-4: Agent 테이블 없음 — no-op (presence 는 heartbeat/레지스트리).
  async markOffline(agentId: string): Promise<void> {
    void agentId;
  }

  /**
   * Sweep agents whose last_seen_at is older than thresholdMs.
   * Handles NULL last_seen_at safely (IS NOT NULL guard).
   * Returns count of agents marked offline.
   */
  // P4c-4: Agent 테이블 없음 — no-op.
  async sweepOfflineAgents(thresholdMs: number): Promise<number> {
    void thresholdMs;
    return 0;
  }
}
