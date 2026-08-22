// 그래프 질의 API의 NestJS 진입점(ticket 20b07fc8, DESIGN.md 축 3/6). 이
// 티켓 범위에는 MCP 툴/컨트롤러가 없다 — ontology-resolver.service.ts와
// 같은 자세. graph_status 같은 lifecycle 배선(ticket #6, 미배정)이 이
// 서비스를 실제로 호출하기 전까지는 DI 대기 상태다.
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AppOntologyDataSource } from '../../db';
import {
  graphNeighbors,
  graphBlastRadius,
  graphCallPath,
  type GraphReachInput,
  type GraphReachResult,
  type GraphCallPathInput,
  type GraphCallPathResult,
} from './query/graph-query';

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
}
