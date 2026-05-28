import { Injectable } from '@nestjs/common';

export interface LogEntry {
  id: number;
  timestamp: string; // ISO
  level: 'info' | 'warn' | 'error' | 'debug';
  category: string; // e.g. 'MCP', 'Discord', 'Notification', 'DB', 'Auth', 'System'
  message: string;
  meta?: Record<string, any>;
}

// ─── Console fan-out policy ──────────────────────────────────────────────
//
// Every LogService call writes to the in-memory ring unconditionally — the
// admin UI's `/api/admin/logs` viewer keeps reading it the same way. Only
// the console fan-out (the line that lands in `docker logs` / pm2 stdout /
// systemd journal) is gated. Defaults match a production-friendly
// "no chatter unless something is actually wrong" stance:
//
//   error / warn → always to console.
//   info         → only when category is in the whitelist below.
//   debug        → never (override with LOG_CONSOLE_DEBUG=true).
//
// Whitelist defaults intentionally cover lifecycle signals an operator
// would lose visibility on without them:
//   - SSE         AgentManager / proxy SSE connect+disconnect, main-session
//                 pin/clear. Low frequency; lifecycle of the live agents.
//   - AgentManager  pairing token mint / redeem. Rare; security-relevant.
//   - System      boot lines (port, MCP endpoint, auth status). One-shot.
//
// Overrides (env vars):
//   LOG_CONSOLE_INFO='all'                  — restore pre-fix behavior (every info)
//   LOG_CONSOLE_INFO='off' | 'none'         — silence info entirely
//   LOG_CONSOLE_INFO='Cat1,Cat2'            — replace whitelist with a CSV
//   LOG_CONSOLE_INFO unset / 'whitelist'    — use DEFAULT_INFO_WHITELIST
//   LOG_CONSOLE_DEBUG='true'                — also fan out debug to console
//
// Why a whitelist instead of touching the 90+ callsites: the bulk of the
// console noise is RequestLoggerInterceptor (`HTTP <method> <url> → <status>`)
// + MCP/StuckDetector/Notification/Archiver lifecycle messages, all of which
// are useful retroactively in the admin UI but distract from real errors
// in stdout. A single chokepoint is faster to revert and safer than
// downgrading individual `info` → `debug` calls in 20+ files.
const DEFAULT_INFO_WHITELIST = new Set(['SSE', 'AgentManager', 'System']);

function buildInfoConsoleFilter(): (cat: string) => boolean {
  const raw = (process.env.LOG_CONSOLE_INFO || '').trim().toLowerCase();
  if (raw === '' || raw === 'whitelist') return (cat) => DEFAULT_INFO_WHITELIST.has(cat);
  if (raw === 'all') return () => true;
  if (raw === 'off' || raw === 'none') return () => false;
  // CSV — preserve the original (un-lowercased) value for case-sensitive
  // category matching. Categories are PascalCase by convention in callsites.
  const rawOriginal = (process.env.LOG_CONSOLE_INFO || '').trim();
  const set = new Set(
    rawOriginal
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return (cat) => set.has(cat);
}

const INFO_CONSOLE_ALLOWED = buildInfoConsoleFilter();
const DEBUG_CONSOLE_ENABLED =
  (process.env.LOG_CONSOLE_DEBUG || '').trim().toLowerCase() === 'true';

@Injectable()
export class LogService {
  private logs: LogEntry[] = [];
  private nextId = 1;
  private maxSize = 2000;

  log(level: LogEntry['level'], category: string, message: string, meta?: Record<string, any>) {
    const entry: LogEntry = {
      id: this.nextId++,
      timestamp: new Date().toISOString(),
      level,
      category,
      message,
      meta,
    };
    this.logs.push(entry);
    if (this.logs.length > this.maxSize) {
      this.logs = this.logs.slice(-this.maxSize);
    }
    // Console fan-out for docker/pm2/systemd log collection. Gated per
    // level — see the policy comment at the top of this file. The
    // in-memory ring above is unconditional; only stdout/stderr is
    // filtered, so the admin UI's log viewer always sees the full stream.
    const prefix = `[${category}]`;
    if (level === 'error') {
      console.error(prefix, message, meta || '');
    } else if (level === 'warn') {
      console.warn(prefix, message, meta || '');
    } else if (level === 'info') {
      if (INFO_CONSOLE_ALLOWED(category)) console.log(prefix, message, meta || '');
    } else if (level === 'debug') {
      if (DEBUG_CONSOLE_ENABLED) console.log(prefix, message, meta || '');
    }

    return entry;
  }

  info(category: string, message: string, meta?: Record<string, any>) { return this.log('info', category, message, meta); }
  warn(category: string, message: string, meta?: Record<string, any>) { return this.log('warn', category, message, meta); }
  error(category: string, message: string, meta?: Record<string, any>) { return this.log('error', category, message, meta); }
  debug(category: string, message: string, meta?: Record<string, any>) { return this.log('debug', category, message, meta); }

  query(params: {
    level?: string;
    category?: string;
    since?: string;  // ISO timestamp — exclusive lower bound (>)
    until?: string;  // ISO timestamp — inclusive upper bound (<=)
    limit?: number;
    search?: string;
  }): LogEntry[] {
    let result = [...this.logs];
    if (params.level) result = result.filter(e => e.level === params.level);
    if (params.category) result = result.filter(e => e.category === params.category);
    if (params.since) {
      const sinceDate = new Date(params.since).getTime();
      result = result.filter(e => new Date(e.timestamp).getTime() > sinceDate);
    }
    if (params.until) {
      const untilDate = new Date(params.until).getTime();
      result = result.filter(e => new Date(e.timestamp).getTime() <= untilDate);
    }
    if (params.search) {
      const s = params.search.toLowerCase();
      result = result.filter(e => e.message.toLowerCase().includes(s) || JSON.stringify(e.meta || {}).toLowerCase().includes(s));
    }
    result.reverse(); // newest first
    if (params.limit) result = result.slice(0, params.limit);
    return result;
  }

  getCategories(): string[] {
    return [...new Set(this.logs.map(e => e.category))];
  }

  getStats(): { total: number; byLevel: Record<string, number>; byCategory: Record<string, number> } {
    const byLevel: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    for (const log of this.logs) {
      byLevel[log.level] = (byLevel[log.level] || 0) + 1;
      byCategory[log.category] = (byCategory[log.category] || 0) + 1;
    }
    return { total: this.logs.length, byLevel, byCategory };
  }
}
