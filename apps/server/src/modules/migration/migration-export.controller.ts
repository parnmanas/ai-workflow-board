import { ApiTags } from '@nestjs/swagger';
import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import * as entitiesBarrel from '../../entities';
import { MigrationExportGuard } from '../../common/guards/migration-export.guard';
import { computeSchemaFingerprint, decryptRowForExport } from './migration-crypto';
import { getAppVersion } from './migration-preflight';
import { DeploymentService } from '../deployments/deployment.service';
import { SELF_DEPLOY_ENV_DEFAULT } from '../../common/deployment-options';
import { MIGRATION_EXCLUDED_TABLE_PREFIX, resolveMigrationEntity } from './migration-entity-registry';

const DEFAULT_PAGE_SIZE = 500;
const MAX_PAGE_SIZE = 2000;

/**
 * 소스 서버 전용 export 표면 (ticket 0f638509). 도착지가 이 엔드포인트들만
 * 호출해서 인스턴스 전체를 pull한다 — 소스에는 "import" 개념이 없다(항상
 * 도착지 주도).
 *
 * 인증은 MigrationExportGuard(scope=migration_export ApiKey 전용, dev-mode
 * bypass 없음) — 이 컨트롤러는 전 워크스페이스의 크리덴셜을 포함한 원본
 * row를 그대로 스트리밍하는 표면이라 가장 엄격한 게이트가 필요하다.
 */
@ApiTags('migration-export')
@Controller('api/migration/export')
@UseGuards(MigrationExportGuard)
export class MigrationExportController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly deployments: DeploymentService,
  ) {}

  /** 프리플라이트가 비교할 버전/스키마/테이블 목록 + 행수. */
  @Get('meta')
  async meta(@Res() res: Response) {
    const tables: { entity: string; table: string; row_count: number }[] = [];
    for (const meta of this.dataSource.entityMetadatas) {
      if (meta.tableName.startsWith(MIGRATION_EXCLUDED_TABLE_PREFIX)) continue;
      let rowCount = -1;
      try {
        rowCount = await this.dataSource.getRepository(meta.name).count();
      } catch {
        // 카운트 실패는 치명적이지 않다 — 도착지가 -1을 "알 수 없음"으로 취급.
      }
      tables.push({ entity: meta.name, table: meta.tableName, row_count: rowCount });
    }

    const selfDeploy = await this.deployments.getLatest(null, SELF_DEPLOY_ENV_DEFAULT).catch(() => null);

    return res.json({
      app_version: getAppVersion(),
      commit_sha: selfDeploy?.deployed_commit_sha || '',
      schema_fingerprint: computeSchemaFingerprint(this.dataSource),
      tables,
    });
  }

  /**
   * Keyset 페이지네이션된 단일 테이블 pull. `after`는 마지막으로 받은 PK
   * 값(문자열화) — PK ASC 정렬 + `id > :after`이므로 재시작해도 그 지점부터
   * 정확히 재개되고, 두 번 요청해도 같은 페이지가 반환된다(멱등).
   * `updated_after`는 무중단 리허설(같은 실행을 여러 번 돌려 델타만 재당김)을
   * 위한 선택적 워터마크 필터 — updated_at 컬럼이 없는 엔티티는 무시된다.
   */
  @Get('table/:entity')
  async table(
    @Param('entity') entityName: string,
    @Query('after') after: string | undefined,
    @Query('limit') limitRaw: string | undefined,
    @Query('updated_after') updatedAfter: string | undefined,
    @Res() res: Response,
  ) {
    const EntityClass = resolveMigrationEntity(entitiesBarrel, entityName);
    if (!EntityClass) {
      return res.status(404).json({ error: `Unknown or unsupported entity: ${entityName}` });
    }

    const repo = this.dataSource.getRepository(EntityClass as any);
    const pkNames = repo.metadata.primaryColumns.map((c) => c.propertyName);
    if (pkNames.length < 1 || pkNames.length > 2) {
      return res.status(501).json({
        error: `Entity ${entityName} has ${pkNames.length} primary-key columns — generic export supports 1 or 2`,
      });
    }
    const limit = Math.min(Math.max(parseInt(limitRaw || String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);

    const qb = repo.createQueryBuilder('e');
    pkNames.forEach((name) => qb.addOrderBy(`e.${name}`, 'ASC'));
    qb.take(limit);
    applyKeysetCursor(qb, pkNames, after);
    const hasUpdatedAt = repo.metadata.columns.some((c) => c.propertyName === 'updated_at');
    if (updatedAfter && hasUpdatedAt) {
      const parsed = new Date(updatedAfter);
      if (!isNaN(parsed.getTime())) qb.andWhere('e.updated_at > :updatedAfter', { updatedAfter: parsed });
    }

    const rows = await qb.getMany();
    const plainRows = rows.map((r) => decryptRowForExport(entityName, r as unknown as Record<string, any>));
    const hasMore = rows.length === limit;
    const lastRow = rows[rows.length - 1] as any;
    const nextCursor = hasMore ? encodeCursor(pkNames.map((name) => lastRow[name])) : null;

    return res.json({ rows: plainRows, has_more: hasMore, next_cursor: nextCursor });
  }
}

/**
 * 1~2컬럼 PK 공용 keyset 커서. 단일 컬럼은 값 그대로(하위 호환 + 가독성),
 * 2컬럼(TicketPrerequisite 전용)은 JSON 배열을 encodeURIComponent한 문자열.
 * WHERE 절은 row-value 비교(`(a,b) > (x,y)`) 대신 OR 전개를 쓴다 —
 * archive-helpers.ts의 buildArchiveCursor/parseArchiveCursor와 같은 관례로,
 * sql.js(SQLite)와 Postgres 양쪽에서 드라이버 차이 없이 동일하게 동작한다.
 */
function encodeCursor(values: unknown[]): string {
  if (values.length === 1) return String(values[0]);
  return encodeURIComponent(JSON.stringify(values.map(String)));
}

function decodeCursor(cursor: string, columns: number): string[] {
  if (columns === 1) return [cursor];
  try {
    const parsed = JSON.parse(decodeURIComponent(cursor));
    if (Array.isArray(parsed) && parsed.length === columns) return parsed.map(String);
  } catch {
    // 파싱 실패 — 아래에서 빈 배열로 취급해 커서 없이 처음부터 스캔.
  }
  return [];
}

function applyKeysetCursor(qb: import('typeorm').SelectQueryBuilder<any>, pkNames: string[], after: string | undefined): void {
  if (!after) return;
  const values = decodeCursor(after, pkNames.length);
  if (values.length !== pkNames.length) return;

  if (pkNames.length === 1) {
    qb.andWhere(`e.${pkNames[0]} > :c0`, { c0: values[0] });
    return;
  }
  // 2컬럼 OR 전개: (a > :c0) OR (a = :c0 AND b > :c1)
  const [a, b] = pkNames;
  qb.andWhere(`(e.${a} > :c0) OR (e.${a} = :c0 AND e.${b} > :c1)`, { c0: values[0], c1: values[1] });
}
