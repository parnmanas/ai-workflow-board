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
 * Ontology Graph 자체 sql.js DataSource의 NestJS 측 라이프사이클 소유자
 * (ticket 6ca4894a, DESIGN.md 축 3). SqljsFlushService의 자매 클래스 —
 * 주기적 tick / dirty-flag 게이팅 / 종료 시 최종 flush 형태는 같지만,
 * primary DataSource 대신 AppOntologyDataSource를 대상으로 하고,
 * `@InjectDataSource()`로 주입받지 않는다: AppOntologyDataSource는 db.ts의
 * 평범한 모듈 레벨 싱글턴이라(TypeOrmModule로 등록된 적 없음), standalone
 * mcp-server.ts 진입점이 직접 소비하는 것과 같은 방식이다.
 *
 * 이 서비스가 없으면, DatabaseModule의 TypeOrmModule.forRoot()는 오직
 * PRIMARY DataSource만 초기화한다 — AppOntologyDataSource는 standalone
 * mcp-server.ts 바이너리가 이미 배선을 마쳤음에도 불구하고 `nest start`/
 * `node dist/main.js` 프로세스(AWB가 실제 dev/prod에서 구동하는 combined
 * 서버) 생애 주기 내내 초기화되지 않은 채로 남는다. 이 서비스가 그 공백을
 * 메워서, 별도의 stdio/HTTP standalone MCP 바이너리뿐 아니라 AWB의 NestJS
 * 앱이 도는 어디서든 듀얼 DataSource 분리가 실제로 살아있게 한다.
 */
@Injectable()
export class OntologySqljsFlushService implements OnModuleInit, OnModuleDestroy {
  private readonly enabled = isSqljsBackend();
  private readonly intervalMs = resolveSqljsFlushIntervalMs();
  private tickHandle: NodeJS.Timeout | null = null;

  constructor(private readonly logService: LogService) {}

  async onModuleInit(): Promise<void> {
    // 로컬 const로 좁혀둔다: TS는 아래 setInterval 클로저 안에서 다른
    // 모듈의 `const`에 대한 `!== null` 좁히기를 유지해주지 않는다.
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
