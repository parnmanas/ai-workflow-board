/**
 * Minimal, dependency-free 5-field cron evaluator for the QA scheduler.
 *
 * Why hand-rolled: the scheduler only needs "given a cron expression and a
 * `from` instant, when is the next firing?". Pulling in cron-parser/croner would
 * mean a new dependency + a full package-lock regen (the worktree symlinks a
 * shared node_modules, and root-override churn is a known footgun — see the
 * project notes). The grammar we support covers every realistic QA cadence, so
 * a ~80-line evaluator is the lighter, self-contained choice the ticket asks for
 * ("시간대/cron 파서 의존성은 가벼운 것으로").
 *
 * Grammar — standard 5 fields, space-separated:
 *   minute(0-59) hour(0-23) day-of-month(1-31) month(1-12) day-of-week(0-6, Sun=0)
 * Each field accepts: `*`, `a`, `a-b` (range), `a-b/n` or `* /n` (step),
 * and comma lists of the above (`1,15,30`). `7` is NOT accepted for Sunday
 * (use 0) to keep the parser simple.
 *
 * Semantics:
 *   - All evaluation is in **UTC**. cron has no inherent timezone; interpreting
 *     fields as UTC makes next_run_at a deterministic instant regardless of the
 *     server's local TZ. (interval_ms schedules sidestep this entirely.) This is
 *     documented on the schedule editor + in docs/qa-scheduler.md.
 *   - day-of-month / day-of-week: when BOTH are restricted (neither is `*`),
 *     a timestamp matches if EITHER matches (the standard Vixie-cron OR rule).
 *     When only one is restricted, that one must match.
 *
 * nextAfter() steps minute-by-minute from `from`+1min, capped so an impossible
 * expression (e.g. "0 0 30 2 *" — Feb 30) returns null instead of looping.
 */

export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

// Minutes in ~5 years — the cap for nextAfter()'s minute walk. Any valid cron
// fires far sooner; an unsatisfiable one walks to the cap and yields null.
const MAX_MINUTES_LOOKAHEAD = 5 * 366 * 24 * 60;

function parseField(raw: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const partRaw of raw.split(',')) {
    const part = partRaw.trim();
    if (part === '') throw new Error(`empty cron field segment in "${raw}"`);

    // step: "<range>/<n>" or "*/<n>"
    let stepBase = part;
    let step = 1;
    const slash = part.indexOf('/');
    if (slash >= 0) {
      stepBase = part.slice(0, slash);
      step = Number.parseInt(part.slice(slash + 1), 10);
      if (!Number.isInteger(step) || step <= 0) throw new Error(`bad step in cron field "${part}"`);
    }

    let lo = min;
    let hi = max;
    if (stepBase === '*' || stepBase === '') {
      // full range (with optional step)
    } else if (stepBase.includes('-')) {
      const [a, b] = stepBase.split('-');
      lo = Number.parseInt(a, 10);
      hi = Number.parseInt(b, 10);
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new Error(`bad range in cron field "${part}"`);
    } else {
      lo = hi = Number.parseInt(stepBase, 10);
      if (!Number.isInteger(lo)) throw new Error(`bad value in cron field "${part}"`);
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`cron field "${part}" out of range ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  if (out.size === 0) throw new Error(`cron field "${raw}" matched no values`);
  return out;
}

/** Parse a 5-field cron expression. Throws on malformed input. */
export function parseCron(expr: string): CronFields {
  const fields = (expr || '').trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron must have exactly 5 fields (got ${fields.length}): "${expr}"`);
  }
  const [m, h, dom, mon, dow] = fields;
  return {
    minute: parseField(m, 0, 59),
    hour: parseField(h, 0, 23),
    dom: parseField(dom, 1, 31),
    month: parseField(mon, 1, 12),
    dow: parseField(dow, 0, 6),
    domRestricted: dom.trim() !== '*',
    dowRestricted: dow.trim() !== '*',
  };
}

/** True if `expr` parses as a valid 5-field cron. */
export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr);
    return true;
  } catch {
    return false;
  }
}

function matches(f: CronFields, d: Date): boolean {
  if (!f.minute.has(d.getUTCMinutes())) return false;
  if (!f.hour.has(d.getUTCHours())) return false;
  if (!f.month.has(d.getUTCMonth() + 1)) return false;

  const domOk = f.dom.has(d.getUTCDate());
  const dowOk = f.dow.has(d.getUTCDay());
  if (f.domRestricted && f.dowRestricted) return domOk || dowOk; // Vixie-cron OR rule
  if (f.domRestricted) return domOk;
  if (f.dowRestricted) return dowOk;
  return true; // both '*'
}

/**
 * Next firing strictly AFTER `from` (UTC). Returns null for an unsatisfiable
 * expression. Seconds/millis are zeroed — cron resolution is one minute.
 */
export function nextCronAfter(expr: string, from: Date): Date | null {
  const f = parseCron(expr);
  // Start at the next whole minute after `from`.
  const cursor = new Date(from.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);

  for (let i = 0; i < MAX_MINUTES_LOOKAHEAD; i++) {
    if (matches(f, cursor)) return new Date(cursor.getTime());
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return null;
}
