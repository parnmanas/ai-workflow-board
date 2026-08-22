// Tier 1.5 크로스파일 리졸버의 NestJS 진입점(ticket e52e7f64, DESIGN.md 축
// 1/4). ontology-extraction.service.ts(ticket e14ef1c9)와 같은 자세 — 이
// 티켓 범위에는 MCP 툴/컨트롤러가 없다. graph_status 같은 lifecycle
// 배선(ticket #6, 미배정)이 이 서비스를 실제로 트리거하기 전까지는 DI
// 대기 상태다 — 그래도 AppModule에 등록해 둬야 후속 티켓이 곧바로
// 주입받아 쓸 수 있다.
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AppOntologyDataSource } from '../../db';
import { resolveCrossFileEdges, type ResolveCrossFileEdgesInput, type ResolveSummary } from './resolver/resolve';

@Injectable()
export class OntologyResolverService {
  // ontology-extraction.service.ts와 같은 이유로 필드 재할당 형태로 둔다 —
  // 실제 구현이 기본값이고, 테스트만 이 인스턴스 필드를 재할당한다.
  private resolveCrossFileEdges = resolveCrossFileEdges;

  constructor(@InjectDataSource() private readonly nestDataSource: DataSource) {}

  /** 온톨로지 엔티티가 실제로 synchronize된 DataSource — sql.js는
   *  AppOntologyDataSource(db.ts, 독립 파일/큐/flush), Postgres는
   *  AppOntologyDataSource가 null이라 NestJS가 관리하는 단일 primary
   *  DataSource로 폴백한다(축 3: Postgres는 변경 없음). */
  private resolveOntologyDataSource(): DataSource {
    return AppOntologyDataSource ?? this.nestDataSource;
  }

  async resolveGraph(input: ResolveCrossFileEdgesInput): Promise<ResolveSummary> {
    return this.resolveCrossFileEdges(this.resolveOntologyDataSource(), input);
  }
}
