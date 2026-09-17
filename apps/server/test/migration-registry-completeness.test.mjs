// 회귀 가드 — ticket 3391b2cc. `drift-registry-completeness.test.mjs` ·
// `test-registration-completeness.test.mjs` 와 같은 완전성 가드 계열이다.
//
// 막으려는 버그: `src/entities/` 에 새 엔티티를 추가하면서 배럴
// (`entities/index.ts`)에만 넣고 `modules/migration/migration-entity-registry.ts`
// 의 `MIGRATION_ENTITY_ORDER` 등록을 빠뜨리는 것. 그러면
//   1) 동일 빌드끼리도 프리플라이트가 **항상** 실패하고(main CI red),
//   2) 그 테이블이 인스턴스 이관에서 **조용히** 빠진다.
// 같은 결함이 두 커밋 연속(f285d0b0 → 5a00c5a3) 재발했다.
//
// `migration-preflight.test.mjs` 도 이 공백을 잡지만, 그쪽은 실패 메시지가
// `entities the source reports that this destination's code does not know
// about: X` 라 엔티티를 추가한 사람이 자기 커밋과 연결짓기 어렵다. 이 가드는
// **엔티티 이름 · 소스 파일 · 테이블명 · 구체적 조치법**까지 찍는다.
//
// ⚠️ 이 가드는 "ORDER 또는 CONTROL 중 하나에 있으면 통과" 가 아니다.
// `comparePreflight()` 는 `MIGRATION_CONTROL_ENTITY_NAMES` 를 **소스 쪽에서
// 먼저** 걸러내므로, 누락 엔티티를 CONTROL 에 집어넣어도 양방향 차집합이
// 모두 비면서 프리플라이트 테스트가 똑같이 green 이 된다 — 즉 그 테스트의
// green 은 **틀린 수정으로도 달성 가능**하고, 그 경우 해당 테이블은 이관에서
// 영구히 빠진 채 CI 만 조용해진다. 그래서 아래 "CONTROL 도피" 절이 CONTROL
// 집합을 핀으로 고정하고 사유 문자열까지 요구한다.
//
// 순수 정적 소스 대조다(앱 부팅 없음, TS 컴파일 없음, dist/ 불필요) — 위 두
// 형제 가드와 같은 자세라 매 `npm test` 에서 돌려도 싸다. 판정 기준을 이 파일에
// 하드코딩하지 않고 레지스트리 소스에서 파싱하는 것이 핵심이다(제외 접두사
// `MIGRATION_EXCLUDED_TABLE_PREFIX` 포함) — 제품 쪽 규칙이 바뀌면 가드도 같이
// 따라가야지, 복사본이 따로 늙으면 안 된다.
//
// 총합 등식(배럴 = ORDER + CONTROL + 온톨로지)을 개수로 박지 않는 이유:
// 엔티티가 하나 늘 때마다 stale 해진다 — 그래서 이 주석도 개수를 적지 않는다.
// 아래 양방향 차집합이 그 등식을 숫자 없이 더 강하게 단언한다.
//
// 비공허성(non-vacuity): `MIGRATION_ENTITY_ORDER` 에서 이름 하나를 지우면
// 첫 번째 테스트가 그 이름을 찍으며 실패하고, 반대로 배럴에 없는 이름을
// 넣으면 두 번째 테스트가 실패한다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');
const ENTITIES_DIR = path.join(SERVER_ROOT, 'src/entities');
const BARREL_FILE = path.join(ENTITIES_DIR, 'index.ts');
const REGISTRY_FILE = path.join(SERVER_ROOT, 'src/modules/migration/migration-entity-registry.ts');

const registrySource = fs.readFileSync(REGISTRY_FILE, 'utf8');

/**
 * `MIGRATION_CONTROL_ENTITY_NAMES` 에 들어 있어야 하는 이름 — 가드 쪽 핀.
 *
 * ⚠️ 이 목록을 늘리는 것은 "그 테이블을 인스턴스 이관에서 영구히 뺀다" 는
 * 뜻이다. 새 엔티티를 등록하다 프리플라이트가 빨개졌을 때의 도피처가 아니다.
 * 핀을 여기 둔 이유는 그 판단이 **레지스트리와 이 가드 두 파일을 함께 고치는**
 * 눈에 띄는 변경이 되게 하려는 것이다 — 한 토큰짜리 조용한 도피를 막는다.
 *
 * 늘리기 전에 리뷰어가 확인해야 할 것:
 *   1. 그 테이블이 **이관 기능 자신의 제어 상태**인가 (이관되는 사용자 데이터가
 *      아니라). 예: MigrationRun 은 "이 이관 실행" 자체의 진행 상태다.
 *   2. 도착지에서 **재생성 가능**한가. 재생성 불가능한 설정/사용자 데이터라면
 *      CONTROL 이 아니라 `MIGRATION_ENTITY_ORDER` 가 맞다.
 *   3. `MIGRATION_CONTROL_ENTITY_REASONS` 에 그 판단 근거가 적혔는가.
 */
const PINNED_CONTROL_ENTITY_NAMES = ['MigrationRun'];

// ── 배럴 파싱 ────────────────────────────────────────────────────────────────

// `export { Foo } from './Foo';` 만 잡는다. `export type { ... }` 는 런타임에
// 존재하지 않아 이관 대상이 아니고, 이 정규식이 `export {` 로 시작을 고정하므로
// 자연히 빠진다.
const BARREL_CLASS_EXPORT_RE = /^export \{ (\w+) \} from '\.\/([\w.-]+)';$/gm;

function readBarrelEntityExports() {
  const source = fs.readFileSync(BARREL_FILE, 'utf8');

  // `export { A as B }` / `export { A, B }` 는 아래 파싱 전제를 깬다(전자는
  // 클래스명과 export 이름이 갈리는데, resolveMigrationEntity 는 export 이름으로
  // 찾고 TypeORM 메타데이터는 클래스명을 쓴다 — 갈리면 그 자체가 버그다).
  // 조용히 건너뛰지 말고 여기서 멈춘다.
  const unsupported = source
    .split('\n')
    .filter((line) => /^export \{/.test(line) && !/^export \{ \w+ \} from '\.\/[\w.-]+';$/.test(line));
  assert.deepEqual(
    unsupported,
    [],
    `${path.relative(SERVER_ROOT, BARREL_FILE)} 에 이 가드가 파싱하지 못하는 export 형태가 있습니다 — ` +
      `한 줄에 클래스 하나(\`export { Foo } from './Foo';\`)만 쓰거나, 이 가드의 파서를 함께 고치세요. ` +
      `특히 \`as\` 별칭은 export 이름과 클래스명을 갈라놓아 resolveMigrationEntity() 조회와 TypeORM ` +
      `엔티티명이 어긋나므로 그 자체로 버그입니다: ${unsupported.join(' / ')}`,
  );

  return [...source.matchAll(BARREL_CLASS_EXPORT_RE)].map(([, className, file]) => ({ className, file }));
}

/** 해당 클래스 바로 위에 붙은 `@Entity('table')` 의 테이블명을 읽는다. */
function readEntityTableName({ className, file }) {
  const relSource = path.join('src/entities', `${file}.ts`);
  const absSource = path.join(ENTITIES_DIR, `${file}.ts`);
  assert.ok(
    fs.existsSync(absSource),
    `배럴이 ${relSource} 에서 ${className} 을 export 하는데 그 파일이 없습니다(이름 변경/삭제 후 배럴 미갱신?)`,
  );
  const source = fs.readFileSync(absSource, 'utf8');

  // 단어 경계를 걸어야 `export class Foo` 검색이 `export class FooBar` 에 걸리지
  // 않는다 — 걸리면 엉뚱한 클래스의 @Entity 테이블명을 읽고도 조용히 통과한다.
  const classMatch = new RegExp(String.raw`^export class ${className}\b`, 'm').exec(source);
  assert.ok(classMatch, `${relSource} 에 \`export class ${className}\` 선언이 없습니다`);
  const classIdx = classMatch.index;

  // 클래스 선언 위쪽에서 가장 가까운 @Entity 데코레이터를 집는다(파일에 클래스가
  // 여러 개여도 올바른 짝을 고른다).
  const decorator = [...source.slice(0, classIdx).matchAll(/@Entity\(\s*'([^']+)'/g)].pop();
  assert.ok(
    decorator,
    `${relSource} 의 ${className} 에 \`@Entity('table')\` 데코레이터가 없습니다. ` +
      `엔티티 배럴은 database.module.ts 가 \`Object.values(entitiesBarrel)\` 로 TypeOrmModule.forFeature() ` +
      `목록을 만드는 입력이라, 엔티티가 아닌 클래스를 여기서 export 하면 그 목록이 깨집니다 — ` +
      `배럴에서 빼고 원본 모듈에서 직접 import 하세요.`,
  );
  return decorator[1];
}

// ── 레지스트리 파싱 ──────────────────────────────────────────────────────────

/** `export const NAME = ... [\n];` 형태의 배열/객체 리터럴 본문을 통째로 잘라낸다. */
function extractDeclarationBody(declaration, closing) {
  const start = registrySource.indexOf(declaration);
  assert.ok(start >= 0, `${path.relative(SERVER_ROOT, REGISTRY_FILE)} 에서 \`${declaration}\` 선언을 찾지 못했습니다`);
  const end = registrySource.indexOf(closing, start);
  assert.ok(end >= 0, `\`${declaration}\` 의 닫는 \`${closing.trim()}\` 를 찾지 못했습니다`);
  return registrySource.slice(start, end);
}

function readExcludedTablePrefix() {
  const match = registrySource.match(/export const MIGRATION_EXCLUDED_TABLE_PREFIX = '([^']+)';/);
  assert.ok(match, '레지스트리에서 MIGRATION_EXCLUDED_TABLE_PREFIX 를 읽지 못했습니다');
  return match[1];
}

function readEntityOrder() {
  const body = extractDeclarationBody('export const MIGRATION_ENTITY_ORDER', '\n];');
  return [...body.matchAll(/'([A-Za-z0-9_]+)'/g)].map((m) => m[1]);
}

/**
 * `MIGRATION_CONTROL_ENTITY_REASONS` 의 `이름: '사유'` 항목을 읽는다.
 * 사유를 문자열 리터럴 한 줄로 못 읽으면 그 항목은 아예 안 잡히고, 그러면 아래
 * 핀 비교가 불일치로 실패한다 — 파싱 실패가 조용한 통과로 새지 않는다.
 */
function readControlEntityReasons() {
  const body = extractDeclarationBody('export const MIGRATION_CONTROL_ENTITY_REASONS', '\n};');
  const entries = [...body.matchAll(/^ {2}(\w+):\s*'((?:[^'\\]|\\.)*)',$/gm)];
  return entries.map(([, name, reason]) => ({ name, reason }));
}

// ── 수집 ─────────────────────────────────────────────────────────────────────

const excludedTablePrefix = readExcludedTablePrefix();
const barrelEntities = readBarrelEntityExports().map((e) => ({ ...e, table: readEntityTableName(e) }));
const migratableEntities = barrelEntities.filter((e) => !e.table.startsWith(excludedTablePrefix));
const entityOrder = readEntityOrder();
const controlReasons = readControlEntityReasons();
const controlNames = controlReasons.map((c) => c.name);
const registeredNames = new Set([...entityOrder, ...controlNames]);

const describe = (e) => `${e.className} (src/entities/${e.file}.ts, 테이블 ${e.table})`;

// ── 테스트 ───────────────────────────────────────────────────────────────────

test('스캔 자체가 비어 있지 않다 (비공허성)', () => {
  assert.ok(
    barrelEntities.length > 50,
    `배럴에서 엔티티를 ${barrelEntities.length} 개만 찾았습니다 — 파서가 깨진 것이지 완전성의 증거가 아닙니다`,
  );
  assert.ok(
    migratableEntities.length > 50,
    `이관 대상 후보가 ${migratableEntities.length} 개뿐입니다 — 제외 접두사 '${excludedTablePrefix}' 파싱이 깨졌을 수 있습니다`,
  );
  assert.ok(entityOrder.length > 50, `MIGRATION_ENTITY_ORDER 를 ${entityOrder.length} 개만 읽었습니다 — 파서가 깨졌습니다`);
});

test('배럴에 export 된 모든 엔티티가 이관 레지스트리에 등록돼 있다', () => {
  const missing = migratableEntities.filter((e) => !registeredNames.has(e.className));
  assert.deepEqual(
    missing.map(describe),
    [],
    '엔티티가 배럴(src/entities/index.ts)에는 있는데 이관 레지스트리에는 없습니다. ' +
      '이 상태에서는 (1) 동일 빌드끼리도 migration preflight 가 항상 실패해 main CI 가 red 가 되고, ' +
      '(2) resolveMigrationEntity() 가 이 이름을 거부해 해당 테이블이 인스턴스 이관에서 조용히 빠집니다. ' +
      '조치: src/modules/migration/migration-entity-registry.ts 의 MIGRATION_ENTITY_ORDER 에 ' +
      '클래스명을 추가하세요 — 참조하는 부모 엔티티보다 뒤에 두면 됩니다(실제 FK 11개는 파일 상단 주석 참고). ' +
      '⚠️ MIGRATION_CONTROL_ENTITY_REASONS 에 넣어 통과시키지 마세요: 그건 "이관에서 영구히 제외" 라는 뜻이고, ' +
      'comparePreflight() 가 CONTROL 이름을 소스 쪽에서 먼저 걸러내므로 테스트만 조용해진 채 데이터가 유실됩니다. ' +
      `누락: ${missing.map(describe).join(' / ')}`,
  );
});

test('이관 레지스트리의 모든 이름이 배럴의 실제 이관 대상 엔티티다', () => {
  const migratableNames = new Set(migratableEntities.map((e) => e.className));
  const ontologyNames = new Set(
    barrelEntities.filter((e) => e.table.startsWith(excludedTablePrefix)).map((e) => e.className),
  );
  const ghosts = [...registeredNames].filter((name) => !migratableNames.has(name));
  assert.deepEqual(
    ghosts,
    [],
    '이관 레지스트리에 배럴의 이관 대상 엔티티가 아닌 이름이 있습니다. ' +
      `접두사 '${excludedTablePrefix}' 테이블(온톨로지 그래프)은 의도적 제외 대상이라 등록하면 안 되고, ` +
      '그 외의 이름은 오타이거나 이름 변경·삭제 후 레지스트리를 안 고친 흔적입니다. ' +
      'MIGRATION_ENTITY_ORDER 에 유령 이름이 남으면 도착지가 소스에 없는 엔티티를 기대해 ' +
      'entities_missing_on_source 로 프리플라이트가 항상 실패합니다. ' +
      `유령 항목: ${ghosts.map((n) => (ontologyNames.has(n) ? `${n} (온톨로지 — 제외 대상)` : n)).join(', ')}`,
  );
});

test('MIGRATION_ENTITY_ORDER 에 중복 항목이 없다', () => {
  const seen = new Set();
  const duplicates = [];
  for (const name of entityOrder) {
    if (seen.has(name)) duplicates.push(name);
    seen.add(name);
  }
  assert.deepEqual(
    duplicates,
    [],
    `MIGRATION_ENTITY_ORDER 에 같은 엔티티가 두 번 이상 있습니다 — 이관이 그 테이블을 두 번 훑습니다: ${duplicates.join(', ')}`,
  );
});

// ── CONTROL 도피 차단 ────────────────────────────────────────────────────────

test('CONTROL 목록이 핀과 정확히 일치한다 (조용한 이관 제외 차단)', () => {
  assert.deepEqual(
    [...controlNames].sort(),
    [...PINNED_CONTROL_ENTITY_NAMES].sort(),
    'MIGRATION_CONTROL_ENTITY_REASONS 의 항목이 이 가드의 핀(PINNED_CONTROL_ENTITY_NAMES)과 다릅니다. ' +
      'CONTROL 등재는 "이 테이블을 인스턴스 이관에서 영구히 뺀다" 는 뜻이라 조용히 늘어나면 안 됩니다 — ' +
      'comparePreflight() 가 CONTROL 이름을 소스 쪽에서 먼저 걸러내기 때문에, ' +
      '누락 엔티티를 여기 넣어도 프리플라이트는 green 이 되고 그 테이블만 사라집니다. ' +
      '정말 제어 테이블이라면 이 가드의 핀도 함께 고치고, 그 판단 근거를 리뷰에 남기세요 ' +
      '(핀 위 주석의 확인 항목 3개). 새 엔티티 등록 누락을 덮으려던 것이라면 ' +
      'MIGRATION_ENTITY_ORDER 쪽이 맞습니다.',
  );
});

test('CONTROL 항목마다 사유가 적혀 있다', () => {
  const weak = controlReasons.filter(({ name, reason }) => reason.trim().length < 20 || reason.trim() === name);
  assert.deepEqual(
    weak.map((c) => `${c.name}: ${JSON.stringify(c.reason)}`),
    [],
    'MIGRATION_CONTROL_ENTITY_REASONS 항목에 실질적인 사유가 없습니다. ' +
      '이 목록은 이관에서 영구 제외되는 테이블이라 "왜 이관 대상이 아닌가" 가 소스에 남아 있어야 합니다: ' +
      `${weak.map((c) => c.name).join(', ')}`,
  );
});

test('같은 엔티티가 ORDER 와 CONTROL 에 동시에 있지 않다', () => {
  const both = entityOrder.filter((name) => controlNames.includes(name));
  assert.deepEqual(
    both,
    [],
    'ORDER 와 CONTROL 양쪽에 있는 엔티티입니다 — resolveMigrationEntity() 는 허용하는데 ' +
      'listMigratableEntityMetadata()/comparePreflight() 는 걸러내므로 두 쪽 판단이 어긋납니다. ' +
      `한쪽만 남기세요: ${both.join(', ')}`,
  );
});
