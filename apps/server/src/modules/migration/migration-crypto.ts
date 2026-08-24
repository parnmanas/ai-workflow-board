import { createHash } from 'crypto';
import { DataSource } from 'typeorm';
import { decryptStrict, encrypt } from '../../services/encryption.service';

/**
 * 행 단위로 암호화된 필드를 갖는 두 엔티티 — Credential(모든 행 암호화)과
 * SystemSetting(is_secret=1인 행만 암호화, 예: embedding.api_key). 둘 다
 * "소스에서 복호화 → 전송(TLS) → 도착지에서 재암호화"가 필요한 같은 버그
 * 클래스(암호화 키가 이관되지 않으면 영구 복호화 불가)에 속한다.
 */
const ENCRYPTED_FIELD_BY_ENTITY: Record<string, string> = {
  Credential: 'encrypted_data',
  SystemSetting: 'value',
};

function isSecretSettingRow(entityName: string, row: Record<string, any>): boolean {
  if (entityName !== 'SystemSetting') return true;
  return row?.is_secret === 1 || row?.is_secret === true;
}

/**
 * 소스 export 경로: 암호화된 필드를 평문으로 바꿔 반환한다. TLS 구간에서만
 * 평문으로 존재하고(설계 스케치 리스크 항목), 디스크에는 절대 닿지 않는다.
 * decryptStrict는 실패 시 throw — decrypt()의 "실패 시 조용히 빈 문자열"은
 * 마이그레이션에서 크리덴셜을 조용히 지워버리는 것과 같으므로 여기서는
 * 절대 쓰지 않는다.
 */
export function decryptRowForExport(entityName: string, row: Record<string, any>): Record<string, any> {
  const field = ENCRYPTED_FIELD_BY_ENTITY[entityName];
  if (!field || !row[field] || !isSecretSettingRow(entityName, row)) return row;
  return { ...row, [field]: decryptStrict(row[field]) };
}

/**
 * 도착지 import 경로: 평문으로 도착한 필드를 이 프로세스 자신의 암호화 키로
 * 재암호화한다. encrypt()는 도착지 프로세스가 자동으로 자기
 * ENCRYPTION_KEY/.encryption_key를 사용하므로 별도 키 전달이 없다 — 이게
 * 이 기능이 pg_dump 대비 주는 핵심 이득(암호화 키 이관 자체가 설계상 사라짐).
 */
export function reencryptRowForImport(entityName: string, row: Record<string, any>): Record<string, any> {
  const field = ENCRYPTED_FIELD_BY_ENTITY[entityName];
  if (!field || !row[field] || !isSecretSettingRow(entityName, row)) return row;
  return { ...row, [field]: encrypt(row[field]) };
}

// Ontology Graph 테이블(ticket 6ca4894a)은 sql.js에서 별도 세컨더리
// DataSource로 분리되어 있어(db.ts ONTOLOGY_ENTITIES) primary DataSource의
// entityMetadatas에 아예 나타나지 않는 반면, Postgres에서는 같은 단일
// DataSource에 포함된다(db.ts 주석 참고). 필터링 없이 핑거프린트를 계산하면
// "sqlite ↔ Postgres" 비교가 코드가 완전히 동일해도 항상 불일치로 뜬다 —
// 완료 기준 5(sqlite 소스 → Postgres 도착지)를 프리플라이트 단계에서 막아
// 버리므로 반드시 제외한다. 온톨로지 그래프 자체는 이 마이그레이션의 범위
// 밖(재추출 가능한 파생 데이터) — MIGRATION_ENTITY_ORDER에서도 동일하게
// 제외한다.
const EXCLUDED_TABLE_PREFIX = 'ontology_';

/**
 * 스키마 핑거프린트 — 소스/도착지 양쪽에서 반드시 같은 방식으로 계산해야
 * 의미 있는 비교가 된다(그래서 export controller와 import service가 이
 * 하나의 함수를 공유). `synchronize: true`(D-01)로 스키마가 엔티티 코드에서
 * 직접 파생되므로, 테이블명+컬럼명+컬럼타입의 정렬된 목록을 해시하면 "두
 * 서버가 같은 엔티티 코드를 실행 중인가"를 스키마 레벨에서 검증할 수 있다.
 */
export function computeSchemaFingerprint(dataSource: DataSource): string {
  const lines: string[] = [];
  for (const meta of dataSource.entityMetadatas) {
    if (meta.tableName.startsWith(EXCLUDED_TABLE_PREFIX)) continue;
    const cols = meta.columns
      .map((c) => `${c.databaseName}:${String(c.type)}`)
      .sort()
      .join(',');
    lines.push(`${meta.tableName}[${cols}]`);
  }
  lines.sort();
  return createHash('sha256').update(lines.join('|')).digest('hex');
}
