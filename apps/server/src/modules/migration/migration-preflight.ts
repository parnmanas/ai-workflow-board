import * as fs from 'fs';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { computeSchemaFingerprint } from './migration-crypto';
import { MigrationSourceMeta } from './migration-client';
import { MIGRATION_ENTITY_ORDER, MIGRATION_EXCLUDED_TABLE_PREFIX } from './migration-entity-registry';

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

  if (source.schema_fingerprint !== local.schema_fingerprint) {
    reasons.push(
      `schema_fingerprint mismatch (source=${source.schema_fingerprint.slice(0, 12)}… dest=${local.schema_fingerprint.slice(0, 12)}…) — source and destination are running different entity code`,
    );
  }
  if (source.app_version && local.app_version && source.app_version !== local.app_version) {
    reasons.push(`app_version mismatch (source=${source.app_version} dest=${local.app_version})`);
  }

  const sourceEntitySet = new Set(
    source.tables.filter((t) => !t.table.startsWith(MIGRATION_EXCLUDED_TABLE_PREFIX)).map((t) => t.entity),
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
