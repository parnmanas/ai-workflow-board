import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import * as v8 from 'node:v8';
import { LogService } from './log.service';
import { MemoryMetricsRegistry } from './memory-metrics.registry';

/**
 * Self-monitoring heartbeat that records the server's own heap stats
 * into the LogService ring at a fixed cadence. Two purposes:
 *
 *   1. Operators tracking a memory-leak hunt no longer need to keep an
 *      `/api/admin/diagnostics/memory` curl loop running — the in-memory
 *      log ring (and its admin UI viewer at /api/admin/logs) already
 *      shows the trend, labelled `[Memory]`, one row per tick.
 *   2. When the next OOM crash hits, the V8 heap snapshot tells us
 *      *what* is retained, and the immediately-preceding `[Memory]`
 *      log rows tell us *how fast* it grew — which is the difference
 *      between "leak source identified" and "leak source identified
 *      plus reproducer cadence to verify the fix against."
 *
 * Default cadence is 5 min (production safe — cheap enough that the
 * row count over a week stays under 2000, the LogService ring cap).
 * Override via `MEMORY_WATCHDOG_TICK_MS` for an aggressive incident
 * (clamped 30s..1h).
 *
 * Threshold-aware logging:
 *   - level=info while used/limit < 70% (normal headroom)
 *   - level=warn at >=70%  (heading toward GC thrashing — operator
 *     should consider taking a manual heap snapshot now)
 *   - level=error at >=90% (imminent OOM — V8's own
 *     `--heapsnapshot-near-heap-limit` will kick in here too, this
 *     row just makes the LogService picture match what V8 is doing)
 *
 * Why not also push to a metrics backend (Prometheus etc): we don't
 * have one wired today. Adding one is a separate decision, and the
 * LogService ring + DiagnosticsController combo is enough for the
 * single-host NAS deployments AWB is operated on.
 */

const DEFAULT_TICK_MS = 5 * 60_000;        // 5 min
const MIN_TICK_MS = 30_000;                // 30 s (incident response cadence)
const MAX_TICK_MS = 60 * 60_000;           // 1 hour

function clampTickMs(): number {
  const raw = Number.parseInt(process.env.MEMORY_WATCHDOG_TICK_MS || '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TICK_MS;
  return Math.min(MAX_TICK_MS, Math.max(MIN_TICK_MS, raw));
}

// Any registered in-memory collection whose size reaches this many entries
// trips a one-shot warn (see the debounce in snapshot()). Default 1000 is
// comfortably above normal steady-state for every gauge we register (MCP
// sessions are capped at 200, presence/SSE track live viewers, the log ring
// caps at 2000) — so a breach means a collection is growing unbounded, i.e.
// a leak. 0 / invalid disables the collection warn entirely.
const DEFAULT_COLLECTION_WARN = 1000;

function collectionWarnThreshold(): number {
  const raw = Number.parseInt(process.env.MEMORY_WATCHDOG_COLLECTION_WARN || '', 10);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_COLLECTION_WARN;
  return raw;
}

@Injectable()
export class MemoryWatchdogService implements OnModuleInit, OnModuleDestroy {
  private readonly tickMs = clampTickMs();
  private readonly collectionWarnAt = collectionWarnThreshold();
  private tickHandle: NodeJS.Timeout | null = null;
  // Names of collections currently above the warn threshold. Edge-triggered
  // debounce: we warn only when a name newly ENTERS this set, and re-arm
  // (allow a future warn) only after it drops back below threshold. Keeps a
  // persistently-large collection from spamming a warn every tick.
  private breachingCollections = new Set<string>();

  constructor(
    private readonly logService: LogService,
    private readonly metrics: MemoryMetricsRegistry,
  ) {
    // LogService can't self-register (it's manually `new`'d in the standalone
    // MCP context, where the registry isn't wired), so the watchdog — which
    // already holds a LogService ref — registers the log-ring gauge here.
    this.metrics.register('log.entries', () => this.logService.count);
  }

  onModuleInit(): void {
    // Tick once on boot so the very first sample (before anyone has
    // hit any endpoint) is in the record. Operators correlating an
    // OOM against deployment time want this baseline.
    this.snapshot();
    this.tickHandle = setInterval(() => this.snapshot(), this.tickMs);
    // Mirror the unref pattern used everywhere else: this timer alone
    // shouldn't keep the node process alive past shutdown.
    if (typeof this.tickHandle?.unref === 'function') this.tickHandle.unref();
  }

  onModuleDestroy(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  /**
   * Public so unit tests / health probes can take a synchronous
   * sample without spinning up the timer. Same data the
   * DiagnosticsController exposes via HTTP — the format here is
   * tuned for the LogService meta column (small object, no per-
   * space breakdown).
   */
  snapshot(): void {
    const mem = process.memoryUsage();
    const heap = v8.getHeapStatistics();
    const limit = heap.heap_size_limit || 1; // avoid div by 0
    const usedPct = (heap.used_heap_size / limit) * 100;
    // Live in-memory collection sizes — same data the diagnostics endpoint
    // serves, folded into the log row so the trend is visible in the admin
    // log viewer without a separate curl loop, and so the rows immediately
    // before an OOM show which map was growing.
    const collections = this.metrics.collect();
    const meta = {
      rss_mb: Math.round(mem.rss / 1_048_576),
      heap_used_mb: Math.round(heap.used_heap_size / 1_048_576),
      heap_total_mb: Math.round(heap.total_heap_size / 1_048_576),
      heap_limit_mb: Math.round(limit / 1_048_576),
      external_mb: Math.round(mem.external / 1_048_576),
      array_buffers_mb: Math.round(mem.arrayBuffers / 1_048_576),
      heap_used_pct: Math.round(usedPct * 10) / 10,
      uptime_min: Math.round(process.uptime() / 60),
      collections,
    };

    this.checkCollectionThresholds(collections);

    // Threshold-aware level: bumps as we approach the OOM cliff so
    // an admin scanning recent warn/error rows in the log viewer
    // doesn't have to scroll through 200 normal info rows first.
    const level: 'info' | 'warn' | 'error' =
      usedPct >= 90 ? 'error' : usedPct >= 70 ? 'warn' : 'info';

    const message =
      usedPct >= 90
        ? `Heap CRITICAL: ${meta.heap_used_mb}/${meta.heap_limit_mb} MB (${meta.heap_used_pct}%) — OOM imminent`
        : usedPct >= 70
          ? `Heap pressure: ${meta.heap_used_mb}/${meta.heap_limit_mb} MB (${meta.heap_used_pct}%)`
          : `Heap: ${meta.heap_used_mb}/${meta.heap_limit_mb} MB (${meta.heap_used_pct}%)`;

    this.logService.log(level, 'Memory', message, meta);
  }

  /**
   * Emit a single warn the first time any collection crosses the configured
   * size threshold, and re-arm it only once the collection drains back below.
   * This is the "임계치 초과 시 warn 로그 1회 (스팸 방지 디바운스)" the ticket asks
   * for — without it a genuinely-leaking map would log a warn on every tick
   * (e.g. every 30s during an incident), drowning the signal it carries.
   */
  private checkCollectionThresholds(collections: Record<string, number>): void {
    if (this.collectionWarnAt <= 0) return; // threshold disabled

    for (const [name, size] of Object.entries(collections)) {
      const wasBreaching = this.breachingCollections.has(name);
      const isBreaching = size >= this.collectionWarnAt;

      if (isBreaching && !wasBreaching) {
        this.breachingCollections.add(name);
        this.logService.warn(
          'Memory',
          `Collection '${name}' size ${size} crossed warn threshold ${this.collectionWarnAt} — possible leak`,
          { collection: name, size, threshold: this.collectionWarnAt },
        );
      } else if (!isBreaching && wasBreaching) {
        // Drained back below threshold — re-arm so a future breach warns again.
        this.breachingCollections.delete(name);
      }
    }
  }
}
