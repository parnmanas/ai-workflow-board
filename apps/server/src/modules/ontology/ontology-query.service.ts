// 그래프 질의 API의 NestJS 진입점(ticket 20b07fc8/d35b7b7d, DESIGN.md 축
// 3/6). ontology-tools.ts(ticket d35b7b7d)가 이 서비스를 실제로 호출하는
// MCP 컨트롤러다 — ontology-resolver.service.ts와 같은 DI 등록 자세.
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AppOntologyDataSource } from '../../db';
import type { OntologyNode } from '../../entities/OntologyNode';
import {
  graphNeighbors,
  graphBlastRadius,
  graphCallPath,
  hydrateNodes,
  type GraphReachInput,
  type GraphReachResult,
  type GraphCallPathInput,
  type GraphCallPathResult,
} from './query/graph-query';
import {
  findSymbol,
  moduleSummary,
  type FindSymbolInput,
  type FindSymbolResult,
  type ModuleSummaryInput,
  type ModuleSummaryResult,
} from './query/symbol-query';

@Injectable()
export class OntologyQueryService {
  constructor(@InjectDataSource() private readonly nestDataSource: DataSource) {}

  /** 온톨로지 엔티티가 실제로 synchronize된 DataSource — sql.js는
   *  AppOntologyDataSource(db.ts, 독립 파일/큐/flush), Postgres는
   *  AppOntologyDataSource가 null이라 NestJS가 관리하는 단일 primary
   *  DataSource로 폴백한다(축 3: Postgres는 변경 없음). */
  private resolveOntologyDataSource(): DataSource {
    return AppOntologyDataSource ?? this.nestDataSource;
  }

  async neighbors(input: GraphReachInput): Promise<GraphReachResult> {
    return graphNeighbors(this.resolveOntologyDataSource(), input);
  }

  async blastRadius(input: GraphReachInput): Promise<GraphReachResult> {
    return graphBlastRadius(this.resolveOntologyDataSource(), input);
  }

  async callPath(input: GraphCallPathInput): Promise<GraphCallPathResult> {
    return graphCallPath(this.resolveOntologyDataSource(), input);
  }

  async findSymbol(input: FindSymbolInput): Promise<FindSymbolResult> {
    return findSymbol(this.resolveOntologyDataSource(), input);
  }

  async moduleSummary(input: ModuleSummaryInput): Promise<ModuleSummaryResult> {
    return moduleSummary(this.resolveOntologyDataSource(), input);
  }

  /** graph_call_path의 path steps(edge 양끝 id만 있음)를 path:line
   *  그라운딩용으로 하이드레이트할 때 ontology-tools.ts가 쓴다 — 온톨로지
   *  전용 DataSource 해소를 서비스 경계 밖으로 새지 않게 감싼다. */
  async hydrateNodesById(graphId: string, ids: string[]): Promise<Map<string, OntologyNode>> {
    return hydrateNodes(this.resolveOntologyDataSource(), graphId, ids);
  }
}
