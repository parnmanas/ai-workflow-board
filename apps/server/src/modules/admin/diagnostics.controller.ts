import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { join } from 'node:path';
import * as v8 from 'node:v8';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { LogService } from '../../services/log.service';
import { MemoryMetricsRegistry } from '../../services/memory-metrics.registry';
import { Workspace } from '../../entities/Workspace';
import {
  DEFAULT_SUPERVISOR_STALE_MS,
  DEFAULT_SUPERVISOR_RESEND_MS,
  DEFAULT_SUPERVISOR_LIVENESS_FLOOR_MS,
  SUPERVISOR_STALE_MS_SANE_MAX,
  SUPERVISOR_TICK_MS,
  resolveSupervisorLivenessFloorMs,
  classifySupervisorStaleMs,
  resolveRecoveryModeMs,
} from '../../common/supervisor-liveness';
import { CURRENT_TASK_STALE_MS } from '../../modules/agents/agent-status.service';

/**
 * Resolve one cadence field the same way TicketSupervisorService.resolveCadence
 * does: a positive finite configured value wins, otherwise the default. Returns
 * both so the diagnostic can show configured-vs-default-vs-effective + source.
 */
function resolveCadenceField(configured: unknown, def: number): {
  configured: number | null; effective: number; source: 'configured' | 'default'; is_default: boolean;
} {
  const n = Number(configured);
  if (Number.isFinite(n) && n > 0) {
    const v = Math.floor(n);
    // `is_default` is the operator-meaningful signal: the column is NOT NULL and
    // backfilled, so `source` is almost always 'configured' — what matters is
    // whether the configured value EQUALS the in-code default or is a custom
    // (possibly incident) value like the 4 h supervisor_stale_ms.
    return { configured: v, effective: v, source: 'configured', is_default: v === def };
  }
  // Null/0/garbage row → the tick falls back to the default (source='default').
  return { configured: null, effective: def, source: 'default', is_default: true };
}

/**
 * Public memory diagnostics — intentionally NOT guarded by Auth/Permission.
 *
 * Rationale: during an active memory-leak investigation an operator needs
 * to hit this endpoint from a browser while logged out, from a curl loop
 * without managing a session token, and from a basic uptime/health probe
 * that has no notion of AWB sessions. The data exposed (heap counters,
 * GC stats, per-space sizes) is process-internal but does not leak any
 * user/agent data, credentials, or ticket content. Operationally that's
 * the same risk profile as `/api/health`.
 *
 * The DESTRUCTIVE side of diagnostics — `POST /api/admin/diagnostics/
 * heap-snapshot`, which stalls the event loop for seconds and writes a
 * multi-GB file to disk — is kept behind the admin guard in
 * `DiagnosticsController` below. Splitting them by HTTP path keeps the
 * "public read, gated write" contract obvious at the route table.
 */
@ApiTags('diagnostics')
@Controller('api/diagnostics')
export class PublicDiagnosticsController {
  constructor(
    private readonly metricsRegistry: MemoryMetricsRegistry,
    @InjectRepository(Workspace) private readonly wsRepo: Repository<Workspace>,
  ) {}

  /**
   * Per-workspace supervisor cadence / liveness diagnostic (ticket 1fcba693).
   *
   * The `ticketSupervisor.staleMsElevated` gauge on `GET memory` only counts how
   * MANY workspaces are mis-set — it can't tell you WHICH one or by how much.
   * This endpoint answers "why is recovery paced slowly here": for every
   * workspace it shows the configured value, the in-code default, the EFFECTIVE
   * value the supervisor tick actually uses, and the source (configured vs
   * default) for supervisor_stale_ms / supervisor_resend_ms, plus the liveness
   * floor, the sane-max, and the `elevated` flag. So a value like the incident's
   * 4 h supervisor_stale_ms is visible at the source, with its provenance —
   * exactly the "출처·effective value가 진단에서 확인 가능" DoD.
   *
   * Same public/read posture and risk profile as `GET memory` (cadence numbers +
   * workspace name; no user/ticket/credential content).
   */
  @Get('supervisor-cadence')
  async getSupervisorCadence() {
    const workspaces = await this.wsRepo.find({ order: { created_at: 'ASC' } });
    const livenessFloorMs = resolveSupervisorLivenessFloorMs();
    const livenessFloorSource =
      livenessFloorMs === DEFAULT_SUPERVISOR_LIVENESS_FLOOR_MS ? 'default' : 'env';

    return {
      timestamp: new Date().toISOString(),
      units: 'ms',
      // Policy constants the supervisor derives from — the "reasonable defaults"
      // half of the DoD, so the diagnostic is self-documenting.
      defaults: {
        supervisor_stale_ms: DEFAULT_SUPERVISOR_STALE_MS,
        supervisor_resend_ms: DEFAULT_SUPERVISOR_RESEND_MS,
        liveness_floor_ms: DEFAULT_SUPERVISOR_LIVENESS_FLOOR_MS,
        sane_max_ms: SUPERVISOR_STALE_MS_SANE_MAX,
        current_task_stale_ms: CURRENT_TASK_STALE_MS,
        // The supervisor re-evaluates once per tick, so every recovery bound is
        // `threshold + up to one tick`. Exposed so an operator reading
        // recovery_thresholds_ms vs recovery_bounds_ms can see where the gap
        // comes from.
        supervisor_tick_ms: SUPERVISOR_TICK_MS,
      },
      liveness_floor: { effective_ms: livenessFloorMs, source: livenessFloorSource },
      elevated_count: workspaces.filter(
        (w) => classifySupervisorStaleMs(resolveCadenceField(w.supervisor_stale_ms, DEFAULT_SUPERVISOR_STALE_MS).effective).elevated,
      ).length,
      workspaces: workspaces.map((w) => {
        const stale = resolveCadenceField(w.supervisor_stale_ms, DEFAULT_SUPERVISOR_STALE_MS);
        const resend = resolveCadenceField(w.supervisor_resend_ms, DEFAULT_SUPERVISOR_RESEND_MS);
        const { elevated } = classifySupervisorStaleMs(stale.effective);
        // Recovery numbers this cadence implies, split by HOW the strand died so
        // an operator reads the REAL guarantee for each case (ticket 1fcba693,
        // reviewer AC — a single "absent" bound conflated two very different
        // numbers). `thresholds` are the detection thresholds (tick-exclusive);
        // `bounds` add one supervisor tick for the actual observed upper bound,
        // so a field named `*_bounds_ms` equals the value it claims. A LEAKED
        // current_task is gated by its TTL (current_task_stale_ms), NOT
        // min(stale, TTL) — a stale window smaller than the TTL cannot reclaim a
        // leaked seat any sooner (the reviewer's stale<15 min correctness fix).
        const recovery = resolveRecoveryModeMs({
          staleMs: stale.effective,
          livenessFloorMs,
          currentTaskStaleMs: CURRENT_TASK_STALE_MS,
          tickMs: SUPERVISOR_TICK_MS,
        });
        return {
          workspace_id: w.id,
          name: w.name,
          supervisor_stale_ms: stale,
          supervisor_resend_ms: resend,
          liveness_floor_ms: livenessFloorMs,
          supervisor_tick_ms: SUPERVISOR_TICK_MS,
          recovery_thresholds_ms: recovery.thresholds,
          recovery_bounds_ms: recovery.bounds,
          elevated,
        };
      }),
    };
  }

  @Get('memory')
  getMemory() {
    const memUsage = process.memoryUsage();
    const heapStats = v8.getHeapStatistics();
    const spaces = v8.getHeapSpaceStatistics();
    return {
      timestamp: new Date().toISOString(),
      uptime_seconds: Math.round(process.uptime()),
      units: 'bytes',
      process: {
        rss: memUsage.rss,
        heap_used: memUsage.heapUsed,
        heap_total: memUsage.heapTotal,
        external: memUsage.external,
        array_buffers: memUsage.arrayBuffers,
      },
      // Live sizes of the long-lived in-memory collections (sessions, SSE
      // maps, registries, log ring). Counts only — no entry content — so
      // exposing them on the unguarded route carries the same risk profile
      // as the heap counters above (see class header). This is the section
      // an operator watches under reconnect/session churn to see whether a
      // map (e.g. `mcp.sessions`) is trending up instead of draining.
      collections: this.metricsRegistry.collect(),
      heap: {
        total: heapStats.total_heap_size,
        used: heapStats.used_heap_size,
        executable: heapStats.total_heap_size_executable,
        physical: heapStats.total_physical_size,
        available: heapStats.total_available_size,
        heap_size_limit: heapStats.heap_size_limit,
        malloced_memory: heapStats.malloced_memory,
        peak_malloced_memory: heapStats.peak_malloced_memory,
        external: heapStats.external_memory,
      },
      spaces: spaces.map((s) => ({
        name: s.space_name,
        size: s.space_size,
        used: s.space_used_size,
        available: s.space_available_size,
        physical: s.physical_space_size,
      })),
    };
  }
}

/**
 * Runtime diagnostics for the AWB server process itself — heap usage, GC
 * pressure, on-demand heap snapshots. Used to identify the source of the
 * "Reached heap limit / FATAL ERROR" OOM crashes we saw on 2026-05-28
 * (Synology NAS, node CPU pinned at 100% from GC thrashing while memory
 * climbed steadily until V8's 4 GB old-space limit was hit).
 *
 * Approach: instead of speculating about which in-memory Map / Set is
 * leaking, ship the numbers themselves. An admin polling `/diagnostics/
 * memory` every minute sees which heap space is growing, when, and on
 * what cadence — enough to correlate against admin-UI activity (board
 * load, agent activity, chat traffic). When the live numbers point at a
 * specific allocator pressure, `/diagnostics/heap-snapshot` writes a
 * full V8 heap snapshot to `/app/data` (the awbdata volume) so a
 * post-mortem dominator analysis in Chrome DevTools can pinpoint the
 * retained graph.
 *
 * Permission: ADMIN_ACCESS only — both endpoints expose process internals
 * (heap addresses indirectly, GC counters) that aren't useful to other
 * roles and could in theory leak deployment fingerprints.
 *
 * Out of scope:
 *   - Auto-trigger heap snapshots on threshold. Already covered by the
 *     `--heapsnapshot-near-heap-limit` flag added in docker-compose.yml;
 *     V8 fires the first 2 snapshots automatically when it senses an
 *     imminent OOM. This controller's POST is the manual override.
 *   - In-memory collection sizes (sessions Map, SSE bucket sizes, etc) are
 *     now reported under `collections` on the public `GET /api/diagnostics/
 *     memory` route, fed by MemoryMetricsRegistry (each holder self-registers
 *     a size gauge). The heap snapshot still shows them as retained-graph
 *     dominators; the gauges add the cheap, pollable trend view.
 */
@ApiBearerAuth('user-session')
@ApiTags('diagnostics')
@Controller('api/admin/diagnostics')
@UseGuards(AuthGuard, PermissionGuard)
@RequirePermission(PERMISSIONS.ADMIN_ACCESS)
export class DiagnosticsController {
  constructor(private readonly logService: LogService) {}

  // `GET memory` moved to `PublicDiagnosticsController` (route
  // `/api/diagnostics/memory`) so an operator can hit it from a browser
  // mid-investigation without juggling a session token. The destructive
  // POST below stays gated — it stalls the event loop for seconds and
  // writes a multi-GB file to disk.

  /**
   * Manually trigger an on-disk heap snapshot. Writes a file named
   * `Heap-<timestamp>-pid<N>-manual.heapsnapshot` to /app/data
   * (the awbdata volume) so the operator can `docker cp` it out and
   * load it in Chrome DevTools → Memory → Load. The file can be large
   * — typically 50-200% of `heap.used` — so the call doubles as a
   * stress moment. Don't call it from a hot dashboard refresh; one
   * snapshot every few minutes when investigating is the intended
   * cadence.
   *
   * Implementation note: v8.writeHeapSnapshot is a *synchronous* C++
   * call that walks the entire heap. On a 4 GB heap it can pause the
   * event loop for several seconds. The route handler still returns
   * (snapshot writes before the response) so the operator's polling
   * UI may see one stalled request — that's the cost of taking the
   * snapshot, not a bug. The cost is precisely why we want this on
   * an explicit POST rather than firing it on a schedule.
   */
  @Post('heap-snapshot')
  async takeHeapSnapshot(): Promise<{ ok: boolean; path: string; bytes: number; duration_ms: number }> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `Heap-${stamp}-pid${process.pid}-manual.heapsnapshot`;
    // /app/data matches the awbdata volume mount in docker-compose.yml.
    // Falls back to process.cwd() if the directory isn't writable (dev
    // host running outside docker); v8 will throw, the controller's
    // global filter catches and reports.
    const dir = process.env.AWB_DATA_DIR || '/app/data';
    const fullPath = join(dir, filename);

    this.logService.warn(
      'Diagnostics',
      `Writing heap snapshot to ${fullPath} (this will pause the event loop briefly)`,
    );

    const start = Date.now();
    const writtenPath = v8.writeHeapSnapshot(fullPath);
    const durationMs = Date.now() - start;

    // Best-effort size report. fs is only needed to stat the file; we
    // avoid promises here because the synchronous write already paused
    // the loop and a follow-up async stat is fine.
    let bytes = 0;
    try {
      const fs = await import('node:fs');
      bytes = fs.statSync(writtenPath).size;
    } catch {
      /* stat failure is non-fatal — the snapshot file itself is what matters */
    }

    this.logService.info('Diagnostics', `Heap snapshot written: ${writtenPath}`, {
      bytes,
      duration_ms: durationMs,
    });

    return { ok: true, path: writtenPath, bytes, duration_ms: durationMs };
  }
}
