import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Agent } from '../../entities/Agent';
import { Ticket } from '../../entities/Ticket';
import { LogService } from '../../services/log.service';

const OFFLINE_THRESHOLD_MS = 60_000; // 60s = 2 missed heartbeats at 30s interval
const SWEEP_INTERVAL_MS = 30_000;    // sweep every 30s
const LOCK_TTL_MS = 30 * 60 * 1000;     // 30 min — matches claim_ticket default TTL
const LOCK_SWEEP_INTERVAL_MS = 60_000;  // every 60s

@Injectable()
export class AgentConnectionService implements OnModuleInit, OnModuleDestroy {
  private offlineSweepHandle: NodeJS.Timeout | null = null;
  private lockSweepHandle: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
    @InjectRepository(Ticket) private readonly ticketRepo: Repository<Ticket>,
    private readonly logService: LogService,
  ) {}

  onModuleInit() {
    this.offlineSweepHandle = setInterval(async () => {
      const count = await this.sweepOfflineAgents(OFFLINE_THRESHOLD_MS);
      if (count > 0) {
        this.logService.info('MCP', `Swept ${count} agent(s) offline (heartbeat timeout)`);
      }
    }, SWEEP_INTERVAL_MS);

    // NOTE: This lock sweep runs only in NestJS mode (onModuleInit is a NestJS lifecycle hook).
    // In standalone mcp-server.ts mode, the in-request TTL check inside claim_ticket
    // provides the gap-fill for expired lock enforcement.
    this.lockSweepHandle = setInterval(async () => {
      const count = await this.sweepExpiredLocks(LOCK_TTL_MS);
      if (count > 0) {
        this.logService.info('MCP', `Swept ${count} expired ticket lock(s)`);
      }
    }, LOCK_SWEEP_INTERVAL_MS);

    // Don't let these housekeeping sweeps keep the Node event loop alive; the
    // server lifecycle owns process exit. (Guarded for fake timers in tests.)
    this.offlineSweepHandle.unref?.();
    this.lockSweepHandle.unref?.();
  }

  onModuleDestroy() {
    if (this.offlineSweepHandle) {
      clearInterval(this.offlineSweepHandle);
      this.offlineSweepHandle = null;
    }
    if (this.lockSweepHandle) {
      clearInterval(this.lockSweepHandle);
      this.lockSweepHandle = null;
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
  async markOffline(agentId: string): Promise<void> {
    const threshold = new Date(Date.now() - OFFLINE_THRESHOLD_MS);
    await this.agentRepo
      .createQueryBuilder()
      .update(Agent)
      .set({ is_online: 0 })
      .where(
        'id = :id AND (last_seen_at IS NULL OR last_seen_at < :threshold)',
        { id: agentId, threshold },
      )
      .execute();
  }

  /**
   * Sweep agents whose last_seen_at is older than thresholdMs.
   * Handles NULL last_seen_at safely (IS NOT NULL guard).
   * Returns count of agents marked offline.
   */
  async sweepOfflineAgents(thresholdMs: number): Promise<number> {
    const threshold = new Date(Date.now() - thresholdMs);
    const result = await this.agentRepo
      .createQueryBuilder()
      .update(Agent)
      .set({ is_online: 0 })
      .where('is_online = 1 AND last_seen_at IS NOT NULL AND last_seen_at < :threshold', { threshold })
      .execute();
    return result.affected ?? 0;
  }

  /**
   * Clear locked_by_agent_id and locked_at on tickets whose lock has exceeded ttlMs.
   * Uses createQueryBuilder().update() to bypass @VersionColumn auto-increment
   * (administrative sweep — version should not change). Returns count of swept tickets.
   */
  async sweepExpiredLocks(ttlMs: number): Promise<number> {
    const threshold = new Date(Date.now() - ttlMs);
    const result = await this.ticketRepo
      .createQueryBuilder()
      .update(Ticket)
      .set({ locked_by_agent_id: null, locked_at: null })
      .where(
        'locked_by_agent_id IS NOT NULL AND locked_at IS NOT NULL AND locked_at < :threshold',
        { threshold }
      )
      .execute();
    return result.affected ?? 0;
  }
}
