import { Injectable } from '@nestjs/common';

export interface LogEntry {
  id: number;
  timestamp: string; // ISO
  level: 'info' | 'warn' | 'error' | 'debug';
  category: string; // e.g. 'MCP', 'Discord', 'Notification', 'DB', 'Auth', 'System'
  message: string;
  meta?: Record<string, any>;
}

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
    // Also forward to original console for docker/pm2 log collection
    const prefix = `[${category}]`;
    if (level === 'error') console.error(prefix, message, meta || '');
    else if (level === 'warn') console.warn(prefix, message, meta || '');
    else console.log(prefix, message, meta || '');

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
