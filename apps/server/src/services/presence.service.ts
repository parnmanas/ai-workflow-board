import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { activityEvents } from './activity.service';
import { LogService } from './log.service';
import { MemoryMetricsRegistry } from './memory-metrics.registry';

/**
 * In-memory ticket-presence tracker.
 *
 * Tracks "who currently has this ticket panel open" by remembering each
 * viewer's last heartbeat. Clients ping every ~15s while the panel is
 * mounted; viewers older than PRESENCE_TTL_MS are evicted by a periodic
 * sweep so a tab close doesn't strand a stale "Alice is here" badge.
 *
 * Storage is intentionally in-process — presence is best-effort, ephemeral,
 * and high-churn. Persistence would buy us nothing and cost a row write per
 * heartbeat. A multi-process deployment will see split-brain presence
 * (each pod tracks only its own subscribers); fixing that needs Redis pub/sub
 * and isn't worth doing until the app actually scales out.
 *
 * Emission rule: ticket_presence fires ONLY on viewer-set transitions
 * (add / remove). Steady-state pings just refresh lastSeen without
 * generating SSE traffic.
 */

interface ViewerEntry {
  type: 'user' | 'agent';
  id: string;
  name: string;
  workspace_id?: string;
  lastSeen: number;
}

const PRESENCE_TTL_MS = 30_000;     // viewer evicted if no heartbeat in 30s
const SWEEP_INTERVAL_MS = 10_000;   // sweep cadence — well under TTL so a stale viewer disappears within ~10s

@Injectable()
export class PresenceService implements OnModuleDestroy {
  // ticket_id -> (viewerKey -> ViewerEntry); viewerKey = `${type}:${id}` so a
  // user and an agent sharing a UUID can't collide.
  private readonly viewers = new Map<string, Map<string, ViewerEntry>>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly logService: LogService,
    metrics: MemoryMetricsRegistry,
  ) {
    // Two gauges: outer = tickets currently being viewed, inner-sum = total
    // tracked viewer entries. The nested-map structure means a leak could
    // hide in either dimension (orphaned ticket buckets, or per-ticket viewer
    // sets that never drain), so report both.
    metrics.register('presence.tickets', () => this.viewers.size);
    metrics.register('presence.viewers', () => {
      let total = 0;
      for (const viewers of this.viewers.values()) total += viewers.size;
      return total;
    });
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    // Don't keep the Node event loop alive for a presence-only sweep; the
    // server lifecycle owns process exit.
    if (this.sweepTimer && typeof (this.sweepTimer as any).unref === 'function') {
      (this.sweepTimer as any).unref();
    }
  }

  onModuleDestroy() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /** Heartbeat — refresh viewer's lastSeen, emitting only if this is a new viewer. */
  ping(ticketId: string, viewer: { type: 'user' | 'agent'; id: string; name: string; workspaceId?: string }): void {
    const key = `${viewer.type}:${viewer.id}`;
    let viewers = this.viewers.get(ticketId);
    const isNew = !viewers || !viewers.has(key);
    if (!viewers) {
      viewers = new Map();
      this.viewers.set(ticketId, viewers);
    }
    viewers.set(key, {
      type: viewer.type,
      id: viewer.id,
      name: viewer.name,
      workspace_id: viewer.workspaceId,
      lastSeen: Date.now(),
    });
    if (isNew) this.emitFor(ticketId);
  }

  /** Explicit leave (e.g., tab close beacon). No-op if viewer wasn't tracked. */
  leave(ticketId: string, viewer: { type: 'user' | 'agent'; id: string }): void {
    const key = `${viewer.type}:${viewer.id}`;
    const viewers = this.viewers.get(ticketId);
    if (!viewers) return;
    if (viewers.delete(key)) {
      if (viewers.size === 0) this.viewers.delete(ticketId);
      this.emitFor(ticketId);
    }
  }

  /** Snapshot of currently-tracked viewers for a ticket. */
  list(ticketId: string): ViewerEntry[] {
    const viewers = this.viewers.get(ticketId);
    return viewers ? Array.from(viewers.values()) : [];
  }

  private sweep(): void {
    const now = Date.now();
    let touchedTickets = 0;
    for (const [ticketId, viewers] of this.viewers) {
      const sizeBefore = viewers.size;
      for (const [key, v] of viewers) {
        if (now - v.lastSeen > PRESENCE_TTL_MS) viewers.delete(key);
      }
      if (viewers.size !== sizeBefore) {
        touchedTickets += 1;
        this.emitFor(ticketId);
        if (viewers.size === 0) this.viewers.delete(ticketId);
      }
    }
    if (touchedTickets > 0) {
      this.logService.debug?.('Presence', `Swept ${touchedTickets} ticket(s)`);
    }
  }

  private emitFor(ticketId: string): void {
    const viewers = this.viewers.get(ticketId);
    // Pick a workspace_id from the first viewer if available — needed by the
    // event scope for client-side filtering. All viewers on the same ticket
    // are by definition in the same workspace, so any one works.
    const workspaceId = viewers ? Array.from(viewers.values())[0]?.workspace_id : undefined;
    activityEvents.emit('ticket_presence', {
      ticket_id: ticketId,
      workspace_id: workspaceId,
      viewers: viewers
        ? Array.from(viewers.values()).map(v => ({ type: v.type, id: v.id, name: v.name }))
        : [],
      timestamp: new Date().toISOString(),
    });
  }
}
