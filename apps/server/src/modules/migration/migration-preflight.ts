import * as fs from 'fs';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { computeSchemaFingerprint } from './migration-crypto';
import { MigrationSourceMeta, MigrationForeignKeyViolation } from './migration-client';
import { MIGRATION_ENTITY_ORDER, MIGRATION_EXCLUDED_TABLE_PREFIX, MIGRATION_CONTROL_ENTITY_NAMES, listMigratableEntityMetadata } from './migration-entity-registry';
import { afterSqljsTransactions } from '../../db';

/** Read-only diagnosis; never delete or silently skip source data. */
export async function checkSourceForeignKeys(dataSource: DataSource): Promise<MigrationSourceMeta['foreign_key_check']> {
  if (dataSource.options.type !== 'sqljs') return null;
  const tables = new Set(listMigratableEntityMetadata(dataSource).map((t) => t.table));
  try {
    // Wait for pending writes so we do not report a transaction's temporary
    // state. Aggregate in SQLite: the response stays bounded by table count.
    // All migrated tables have rowids, including composite-PK prerequisites.
    const violations: MigrationForeignKeyViolation[] = await afterSqljsTransactions(dataSource, () => dataSource.query(
      'SELECT "table", COUNT(DISTINCT rowid) AS orphan_row_count, COUNT(*) AS violation_count ' +
      'FROM pragma_foreign_key_check GROUP BY "table" ORDER BY "table"',
    ), 'migration foreign_key_check');
    return { tables: violations.filter((v) => tables.has(v.table)) };
  } catch {
    throw new Error('Source PRAGMA foreign_key_check failed — cannot verify foreign-key integrity; inspect the source database before retrying migration');
  }
}

let _cachedVersion: string | null = null;

/**
 * `apps/server/package.json`의 version 필드를 직접 읽는다.
 * `process.env.npm_package_version`에 기대지 않는다 — 그건 `npm run <script>`로
 * 기동했을 때만 채워지고, 이 저장소의 문서화된 프로덕션 기동법(`node
 * dist/main.js`, 직접 실행)에서는 항상 undefined다. `__dirname`은 dist/src
 * 양쪽에서 이 파일 기준 3단계 위가 apps/server/이므로 컴파일 여부와 무관하게
 * 같은 상대경로가 성립한다.
 */
export function getAppVersion(): string {
  if (_cachedVersion !== null) return _cachedVersion;
  let resolved = '';
  try {
    const pkgPath = path.join(__dirname, '..', '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    resolved = typeof pkg.version === 'string' ? pkg.version : '';
  } catch {
    resolved = '';
  }
  _cachedVersion = resolved;
  return resolved;
}

export interface LocalPreflightMeta {
  app_version: string;
  schema_fingerprint: string;
  entities: string[];
}

export function computeLocalPreflightMeta(dataSource: DataSource): LocalPreflightMeta {
  return {
    app_version: getAppVersion(),
    schema_fingerprint: computeSchemaFingerprint(dataSource),
    entities: MIGRATION_ENTITY_ORDER,
  };
}

export interface PreflightComparison {
  ok: boolean;
  reasons: string[];
  entities_missing_on_source: string[];
  entities_unknown_to_dest: string[];
}

/**
 * 완료 기준 2 — "버전/스키마 불일치, 비어있지 않은 도착지를 거부한다"의 앞
 * 절반. 스키마 핑거프린트 불일치는 무조건 하드 블록(우회 플래그 없음) — 다른
 * 엔티티 코드가 실행 중이면 그 뒤 pull 도중 임의 지점에서 깨지는 것보다
 * 시작 전에 명확히 거부하는 편이 안전하다. app_version은 양쪽 다 값이 있을
 * 때만 비교한다(둘 다 package.json "1.0.0" 고정이면 오늘은 사실상 항상
 * 통과 — 팀이 버전을 올리기 시작하면 그때부터 의미가 생기는 훅).
 * entities_missing_on_source/entities_unknown_to_dest는 스키마 핑거프린트가
 * 이미 다르다고 판정한 이유를 사람이 읽을 수 있게 풀어주는 진단 정보일 뿐,
 * 별도의 게이트 조건은 아니다(핑거프린트 동일이면 이 두 목록은 항상 빈다).
 */
export function comparePreflight(source: MigrationSourceMeta, local: LocalPreflightMeta): PreflightComparison {
  const reasons: string[] = [];

  const violations = source.foreign_key_check?.tables || [];
  if (violations.length) {
    reasons.push(
      `Source PRAGMA foreign_key_check found orphan rows: ${violations.map((v) => `${v.table}: ${v.orphan_row_count} orphan row(s), ${v.violation_count} FK violation(s)`).join(', ')}. ` +
      'Back up the source database, inspect PRAGMA foreign_key_check and PRAGMA foreign_key_list(table), then restore missing parents or remove confirmed orphan rows and retry. Migration does not delete or skip these rows.',
    );
  }

  if (source.schema_fingerprint !== local.schema_fingerprint) {
    reasons.push(
      `schema_fingerprint mismatch (source=${source.schema_fingerprint.slice(0, 12)}… dest=${local.schema_fingerprint.slice(0, 12)}…) — source and destination are running different entity code`,
    );
  }
  if (source.app_version && local.app_version && source.app_version !== local.app_version) {
    reasons.push(`app_version mismatch (source=${source.app_version} dest=${local.app_version})`);
  }

  // 온톨로지 테이블 접두사 + MigrationRun(이관 대상이 아니라 이 기능 자신의
  // 제어 테이블) 제외 — export controller의 listMigratableEntityMetadata와
  // 같은 필터를 방어적으로 한 번 더 적용한다(구버전 소스가 아직 그 필터를
  // 안 가진 경우 대비, 리뷰 라운드1 P1).
  const sourceEntitySet = new Set(
    source.tables
      .filter((t) => !t.table.startsWith(MIGRATION_EXCLUDED_TABLE_PREFIX))
      .filter((t) => !MIGRATION_CONTROL_ENTITY_NAMES.has(t.entity))
      .map((t) => t.entity),
  );
  const destEntitySet = new Set(local.entities);
  const entitiesMissingOnSource = local.entities.filter((e) => !sourceEntitySet.has(e));
  const entitiesUnknownToDest = [...sourceEntitySet].filter((e) => !destEntitySet.has(e));

  if (entitiesMissingOnSource.length) {
    reasons.push(`entities this destination expects but the source does not report: ${entitiesMissingOnSource.join(', ')}`);
  }
  if (entitiesUnknownToDest.length) {
    reasons.push(`entities the source reports that this destination's code does not know about: ${entitiesUnknownToDest.join(', ')}`);
  }

  return {
    ok: reasons.length === 0,
    reasons,
    entities_missing_on_source: entitiesMissingOnSource,
    entities_unknown_to_dest: entitiesUnknownToDest,
  };
}
