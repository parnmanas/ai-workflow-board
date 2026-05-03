import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not } from 'typeorm';
import { Action } from '../../entities/Action';
import { ActionsService } from './actions.service';
import { LogService } from '../../services/log.service';

// Tick-cadence for the scheduler. We dispatch per-minute granularity; finer
// resolution would mean either drifting timer arithmetic or a real cron
// library. The 60s loop is wall-clock-sloppy by design — Action.last_run_at
// is the dedup gate so a missed tick or a late tick never double-fires.
const TICK_MS = 60_000;

interface CronSpec {
  minute: number | '*';
  hour: number | '*';
  dom: number | '*';
  month: number | '*';
  dow: number | '*';
}

// Parse a 5-field cron expression. Supports wildcards (`*`) and integers in
// each slot — no ranges, lists or step values. That's intentional: this is the
// minimum that lets users say "every hour" / "every Monday at 9am" without
// pulling in a cron library and its parsing edge cases.
function parseCron(expr: string): CronSpec | null {
  const parts = (expr || '').trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const fields: Array<keyof CronSpec> = ['minute', 'hour', 'dom', 'month', 'dow'];
  const out: any = {};
  for (let i = 0; i < 5; i++) {
    const raw = parts[i];
    if (raw === '*') {
      out[fields[i]] = '*';
    } else {
      const n = Number(raw);
      if (!Number.isInteger(n)) return null;
      out[fields[i]] = n;
    }
  }
  return out as CronSpec;
}

function cronMatches(spec: CronSpec, d: Date): boolean {
  const m = d.getMinutes();
  const h = d.getHours();
  const dom = d.getDate();
  const month = d.getMonth() + 1;
  const dow = d.getDay();
  if (spec.minute !== '*' && spec.minute !== m) return false;
  if (spec.hour !== '*' && spec.hour !== h) return false;
  if (spec.dom !== '*' && spec.dom !== dom) return false;
  if (spec.month !== '*' && spec.month !== month) return false;
  if (spec.dow !== '*' && spec.dow !== dow) return false;
  return true;
}

/**
 * Polls the actions table once a minute and dispatches Runs whose `schedule_cron`
 * matches the current wall-clock minute. Dedup is enforced via Action.last_run_at:
 * if it's already been touched within the last 50 seconds, skip — this prevents
 * a second tick within the same wall-clock minute from double-firing.
 */
@Injectable()
export class ActionSchedulerService implements OnModuleInit, OnModuleDestroy {
  #timer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(Action) private readonly actionRepo: Repository<Action>,
    private readonly actionsService: ActionsService,
    private readonly logService: LogService,
  ) {}

  onModuleInit(): void {
    if (process.env.AWB_DISABLE_ACTION_SCHEDULER === 'true') {
      this.logService.info('Actions', 'Scheduler disabled by AWB_DISABLE_ACTION_SCHEDULER');
      return;
    }
    // Align the first tick to the next minute boundary so the first Run lands
    // at a predictable time (helps when users say "every hour" and start the
    // server at 12:00:30 — they don't want the next fire at 13:00:30).
    const now = new Date();
    const msToNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
    setTimeout(() => {
      this._tick().catch(() => {});
      this.#timer = setInterval(() => this._tick().catch(() => {}), TICK_MS);
    }, Math.max(1000, msToNextMinute));
  }

  onModuleDestroy(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  private async _tick(): Promise<void> {
    const now = new Date();
    // Pull only enabled actions with a non-empty cron. Across all workspaces —
    // server is single-tenant in practice and the row count stays small.
    const candidates = await this.actionRepo.find({
      where: { enabled: true, schedule_cron: Not('') },
    });
    for (const action of candidates) {
      const spec = parseCron(action.schedule_cron);
      if (!spec) continue;
      if (!cronMatches(spec, now)) continue;
      // Dedup: if last_run_at is within 50s, this is the same minute boundary.
      if (action.last_run_at) {
        const ageMs = now.getTime() - new Date(action.last_run_at).getTime();
        if (ageMs < 50_000) continue;
      }
      try {
        await this.actionsService.dispatch({
          actionId: action.id,
          triggeredByType: 'system',
          triggeredById: '',
        });
      } catch (e: any) {
        this.logService.warn('Actions', `Scheduled dispatch failed for ${action.id}: ${e?.message || e}`);
      }
    }
  }
}
