import { Injectable } from '@nestjs/common';

/**
 * Lightweight registry of named "gauge" closures that report the live size
 * of an in-memory collection (a Map/Set/Array held by some long-lived
 * service). It exists so the memory-leak observability surface
 * (`GET /api/diagnostics/memory` + the `[Memory]` watchdog log row) can
 * report collection sizes WITHOUT the diagnostics controller having to
 * import and reach into every service — several of the holders are
 * controllers (McpController, EventsController) that Nest can't inject into
 * another controller anyway. Each holder self-registers its own gauge at
 * construction; the reader just calls `collect()`.
 *
 * Deliberately cheap (ticket: "경량 유지 — polling 부하/추가 누수 만들지 말 것"):
 *   - No timers, no retained samples, no history ring. The only state is the
 *     gauge-function map itself (~one entry per service, a dozen total).
 *   - Sizes are computed ON DEMAND when `collect()` is called (endpoint hit
 *     or watchdog tick), never on a background cadence — so it adds no
 *     steady-state CPU and cannot itself become a growing allocation.
 *   - `register()` is keyed by name and idempotent: re-registering the same
 *     name (e.g. a provider re-instantiated under test) overwrites rather
 *     than leaking a second closure.
 *
 * Provided + exported globally from SharedServicesModule so any feature
 * module can inject it without wiring an import.
 */
@Injectable()
export class MemoryMetricsRegistry {
  private readonly gauges = new Map<string, () => number>();

  /**
   * Register (or replace) a named size gauge. `name` is a stable dotted
   * label (e.g. `mcp.sessions`, `auth.sessions`) shown verbatim in the
   * diagnostics output. `fn` must be cheap — it runs synchronously every
   * time someone reads the metrics.
   */
  register(name: string, fn: () => number): void {
    this.gauges.set(name, fn);
  }

  /** Drop a gauge (e.g. on a holder's onModuleDestroy in long-lived tests). */
  unregister(name: string): void {
    this.gauges.delete(name);
  }

  /**
   * Evaluate every registered gauge and return a `{ name: size }` snapshot,
   * key-sorted for stable output. A gauge that throws is reported as `-1`
   * rather than blowing up the whole snapshot — observability must never
   * take down the endpoint it observes.
   */
  collect(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const name of Array.from(this.gauges.keys()).sort()) {
      const fn = this.gauges.get(name)!;
      try {
        out[name] = fn();
      } catch {
        out[name] = -1;
      }
    }
    return out;
  }
}
