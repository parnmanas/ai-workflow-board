import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { LogService } from './log.service';
import {
  AppOntologyDataSource,
  initOntologyDb,
  flushOntologySqljs,
  isSqljsBackend,
  resolveSqljsFlushIntervalMs,
} from '../db';

/**
 * NestJS-side lifecycle owner for the Ontology Graph's own sql.js DataSource
 * (ticket 6ca4894a, DESIGN.md axis 3). Sibling of SqljsFlushService — same
 * periodic-tick / dirty-flag-gated / final-flush-on-shutdown shape — but
 * pointed at AppOntologyDataSource instead of the primary DataSource, and
 * NOT `@InjectDataSource()`-driven: AppOntologyDataSource is a plain module-
 * level singleton in db.ts (never registered via TypeOrmModule), the same
 * way the standalone mcp-server.ts entry point consumes it directly.
 *
 * Without this service, TypeOrmModule.forRoot() in DatabaseModule only ever
 * initializes the PRIMARY DataSource — AppOntologyDataSource would stay
 * uninitialized for the entire lifetime of the `nest start`/`node dist/main.js`
 * process (the actual combined server AWB runs in dev/prod), even though the
 * standalone mcp-server.ts binary already wires it up. This service closes
 * that gap so the dual-DataSource split is live wherever AWB's NestJS app
 * runs, not just under the separate stdio/HTTP standalone MCP binary.
 */
@Injectable()
export class OntologySqljsFlushService implements OnModuleInit, OnModuleDestroy {
  private readonly enabled = isSqljsBackend();
  private readonly intervalMs = resolveSqljsFlushIntervalMs();
  private tickHandle: NodeJS.Timeout | null = null;

  constructor(private readonly logService: LogService) {}

  async onModuleInit(): Promise<void> {
    // Narrowed to a local const: TS does not retain the `!== null` narrowing
    // of a cross-module `const` inside a nested closure (setInterval below).
    const dataSource = AppOntologyDataSource;
    if (!this.enabled || !dataSource) return;

    await initOntologyDb();

    this.tickHandle = setInterval(() => {
      flushOntologySqljs(dataSource).catch((e: unknown) => {
        this.logService.error('OntologySqljsFlush', 'periodic flush failed', { err: String(e) });
      });
    }, this.intervalMs);
    if (typeof this.tickHandle?.unref === 'function') this.tickHandle.unref();

    this.logService.info('OntologySqljsFlush', 'ontology dev sql.js batched flush enabled (own DataSource, own dirty flag)', {
      interval_ms: this.intervalMs,
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    const dataSource = AppOntologyDataSource;
    if (!this.enabled || !dataSource) return;
    try {
      const saved = await flushOntologySqljs(dataSource, true);
      if (saved) this.logService.info('OntologySqljsFlush', 'final ontology flush on shutdown completed');
    } catch (e: unknown) {
      this.logService.error('OntologySqljsFlush', 'final ontology flush on shutdown failed', { err: String(e) });
    }
  }
}
