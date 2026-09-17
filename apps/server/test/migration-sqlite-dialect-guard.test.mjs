// 회귀 가드 — 티켓 d27336bb.
//
// `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 와 `... DROP COLUMN IF EXISTS` 는
// Postgres 전용 구문이다. SQLite 는 이 둘을 파싱하지 못하고
// `near "EXISTS": syntax error` 를 던진다. 마이그레이션은 DatabaseModule 의
// 부팅 경로에서 돌기 때문에(db.ts D-02/P-03), 이 구문 하나가 방언 가드 없이
// 들어오면 sqlite 에서 **앱 부팅 자체가** 죽고 서버 통합 테스트가 통째로
// 무너진다 — AddUserGoogleId1760000000085 가 실제로 그렇게 CI 를 red 로
// 만들었다.
//
// 빌드도 타입체크도 이걸 못 잡는다. 문자열 안의 SQL 이라 tsc 에게는 그냥
// 문자열이고, Postgres 로만 돌리면 영원히 통과한다. 그래서 정적 검사로 막는다.
//
// 검사 대상은 `ADD|DROP COLUMN IF [NOT] EXISTS` 형태로 한정한다.
// `DROP TABLE IF EXISTS` · `DROP INDEX IF EXISTS` · `CREATE TABLE IF NOT EXISTS`
// 같은 다른 IF EXISTS 용법은 SQLite 도 지원하므로 여기서 문제 삼지 않는다
// (실제로 DropLegacyChatMessages1760000000003 과
// PromoteBoardCatalogScopes1760000000069 이 그 형태를 쓰고 있고 정상이다).
//
// 방언 가드(`options.type === 'postgres'`)가 있는 파일은 허용한다 — Postgres
// 에서만 실행된다면 그 구문을 쓰는 게 맞다
// (AddOnTicketDoneActionHook1760000000029 이 그 정상 사례).
//
// 순수 소스 텍스트 검사다(drift-registry-completeness.test.mjs 와 같은 방식)
// — 앱 부팅도 TS 컴파일도 하지 않는다.
//
// 비공허성(non-vacuity): 아래 세 번째 테스트가 고정 샘플로 탐지기 자체를
// 검증한다. 추가로, 실제 마이그레이션 파일에서 방언 가드를 지우고 Postgres
// 전용 구문을 넣으면 첫 번째 테스트가 그 파일명을 짚어 실패한다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../src/database/migrations');

// Postgres 전용 구문. ALTER TABLE 안에서만 쓸 수 있는 형태라 이 조각만 봐도 충분하다.
// `g` 플래그를 붙인 정규식은 `test()` 가 lastIndex 를 들고 다녀 호출마다 결과가
// 달라지므로, 판정용(비-global)과 수집용(global)을 나눠 둔다.
const PG_ONLY_COLUMN_DDL = String.raw`\b(?:ADD|DROP)\s+COLUMN\s+IF\s+(?:NOT\s+)?EXISTS`;
const PG_ONLY_COLUMN_DDL_RE = new RegExp(PG_ONLY_COLUMN_DDL, 'i');
const PG_ONLY_COLUMN_DDL_RE_ALL = new RegExp(PG_ONLY_COLUMN_DDL, 'gi');

// 이 저장소가 쓰는 방언 가드 표현은 두 가지뿐이다(=== 51건, !== 9건).
const DIALECT_GUARD_RE = /options\.type\s*[!=]==\s*'postgres'/;

// 주석 안의 설명문(예: "IF EXISTS guard 로 멱등")이 오탐을 내지 않도록 제거한다.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

function readMigrations() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((file) => ({
      file,
      source: fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'),
    }));
}

test('마이그레이션의 Postgres 전용 컬럼 DDL 은 반드시 방언 가드 뒤에 있어야 한다 (sqlite 부팅 보호)', () => {
  const offenders = [];

  for (const { file, source } of readMigrations()) {
    const code = stripComments(source);
    const hits = code.match(PG_ONLY_COLUMN_DDL_RE_ALL);
    if (!hits) continue;
    if (DIALECT_GUARD_RE.test(code)) continue;
    offenders.push(`${file} — ${[...new Set(hits.map((h) => h.replace(/\s+/g, ' ')))].join(', ')}`);
  }

  assert.deepEqual(
    offenders,
    [],
    '다음 마이그레이션이 방언 가드 없이 Postgres 전용 컬럼 DDL 을 쓴다. ' +
      'SQLite 에서 near "EXISTS": syntax error 로 앱 부팅이 깨진다. ' +
      "`options.type === 'postgres'` 로 분기하거나, 더 나은 방법으로 " +
      'queryRunner.hasColumn() 존재 확인 + 평범한 ADD/DROP COLUMN 으로 바꿔라:\n  ' +
      offenders.join('\n  '),
  );
});

test('이 티켓이 고친 AddUserGoogleId 가 실제로 이식 가능한 형태로 남아 있다', () => {
  const file = '1760000000085-AddUserGoogleId.ts';
  const source = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
  const code = stripComments(source);

  assert.equal(
    PG_ONLY_COLUMN_DDL_RE.test(code),
    false,
    `${file} 에 Postgres 전용 컬럼 DDL 이 되돌아왔다 (티켓 d27336bb 회귀)`,
  );
  assert.match(
    code,
    /hasColumn\(\s*'users'\s*,\s*'google_id'\s*\)/,
    `${file} 은 google_id 존재 여부를 queryRunner.hasColumn() 으로 판정해야 한다`,
  );
});

test('탐지기 자체가 공허하지 않다 — 위반 샘플은 잡고 정상 샘플은 통과시킨다', () => {
  const guarded = `
    const isPostgres = queryRunner.connection.options.type === 'postgres';
    if (!isPostgres) return;
    await queryRunner.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS x VARCHAR');
  `;
  const unguardedAdd = `
    await queryRunner.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS x VARCHAR');
  `;
  const unguardedDrop = `
    await queryRunner.query('ALTER TABLE users DROP COLUMN IF EXISTS x');
  `;
  // SQLite 도 지원하는 형태들 — 오탐이면 안 된다.
  const sqliteSafe = `
    await queryRunner.query('DROP TABLE IF EXISTS chat_messages');
    await queryRunner.query('DROP INDEX IF EXISTS "uq_workflow_functions_board_key"');
    await queryRunner.query('CREATE TABLE IF NOT EXISTS t (id VARCHAR)');
  `;
  // 주석 안의 언급은 위반이 아니다.
  const commentOnly = `
    /** ADD COLUMN IF NOT EXISTS 로 멱등하게 만들었다는 설명 주석. */
    // DROP COLUMN IF EXISTS 를 예전에 썼었다.
    await queryRunner.query('ALTER TABLE users ADD COLUMN x VARCHAR');
  `;

  const violates = (src) => {
    const code = stripComments(src);
    return PG_ONLY_COLUMN_DDL_RE.test(code) && !DIALECT_GUARD_RE.test(code);
  };

  assert.equal(violates(unguardedAdd), true, '가드 없는 ADD COLUMN IF NOT EXISTS 를 놓쳤다');
  assert.equal(violates(unguardedDrop), true, '가드 없는 DROP COLUMN IF EXISTS 를 놓쳤다');
  assert.equal(violates(guarded), false, '방언 가드가 있는 정상 사례를 오탐했다');
  assert.equal(violates(sqliteSafe), false, 'SQLite 도 지원하는 IF EXISTS 용법을 오탐했다');
  assert.equal(violates(commentOnly), false, '주석 안의 언급을 오탐했다');
});
