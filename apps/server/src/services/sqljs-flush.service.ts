import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { LogService } from './log.service';
import { flushSqljs, isSqljsBackend, resolveSqljsFlushIntervalMs } from '../db';

/**
 * Periodic flusher for the dev sql.js database (ticket d5a8594a).
 *
 * The TypeORM sqljs driver's `autoSave` is now OFF (see db.ts
 * buildDataSourceOptions) because it re-serialized and rewrote the ENTIRE
 * in-memory DB on every single write — under AWB's high-frequency audit writes
 * (ActivityLog trigger_emitted/dispatched, AgentErrorLog, Subagent log lines)
 * that is allocation churn + GC pressure that builds up over a long dev session.
 *
 * This service replaces per-write persistence with a coalesced flush:
 *   - a periodic tick (default 30s, override via SQLJS_FLUSH_INTERVAL_MS) that
 *     only exports/writes when there are pending writes (db.ts dirty flag), and
 *   - a final forced flush on graceful shutdown (onModuleDestroy, wired to
 *     process signals via app.enableShutdownHooks() in main.ts).
 *
 * Trade-off: a hard crash (SIGKILL / OOM kill / power loss) can lose up to one
 * flush interval of the most recent writes. That is acceptable for DEV sql.js —
 * local, disposable data. Postgres/MySQL (prod) skip this service entirely and
 * keep persisting per-commit.
 */
@Injectable()
export class SqljsFlushService implements OnModuleInit, OnModuleDestroy {
  private readonly enabled = isSqljsBackend();
  private readonly intervalMs = resolveSqljsFlushIntervalMs();
  private tickHandle: NodeJS.Timeout | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logService: LogService,
  ) {}

  onModuleInit(): void {
    // Prod backends persist per-commit; there is nothing to batch.
    if (!this.enabled) return;

    this.tickHandle = setInterval(() => {
      flushSqljs(this.dataSource).catch((e: unknown) => {
        this.logService.error('SqljsFlush', 'periodic flush failed', { err: String(e) });
      });
    }, this.intervalMs);
    // Mirror the other sweep services — the timer alone shouldn't pin the process.
    if (typeof this.tickHandle?.unref === 'function') this.tickHandle.unref();

    this.logService.info('SqljsFlush', 'dev sql.js batched flush enabled (autoSave off)', {
      interval_ms: this.intervalMs,
      crash_loss_window: 'up to one interval on hard crash; graceful shutdown flushes',
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    if (!this.enabled) return;
    // Final forced flush so a graceful stop never loses the last batch.
    try {
      const saved = await flushSqljs(this.dataSource, true);
      if (saved) this.logService.info('SqljsFlush', 'final flush on shutdown completed');
    } catch (e: unknown) {
      this.logService.error('SqljsFlush', 'final flush on shutdown failed', { err: String(e) });
    }
  }
}
