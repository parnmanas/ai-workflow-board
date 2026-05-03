// Cron parsing for Action.schedule_cron. Lives in its own file (not on either
// service) so ActionsService and ActionSchedulerService can both import the
// validator without forming an import cycle — the previous arrangement
// (parseCron exported from action-scheduler.service, imported by
// actions.service which is itself a constructor dep of the scheduler) left
// one module's exports `undefined` at decorator-eval time and broke Nest DI
// at bootstrap.

export interface CronSpec {
  minute: number | '*';
  hour: number | '*';
  dom: number | '*';
  month: number | '*';
  dow: number | '*';
}

// 5-field cron expression: minute hour dom month dow. Wildcards (`*`) and
// integers only — no ranges, lists, or step values. Matches what the UI
// promises and what the scheduler's tick logic supports.
export function parseCron(expr: string): CronSpec | null {
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

export function cronMatches(spec: CronSpec, d: Date): boolean {
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
