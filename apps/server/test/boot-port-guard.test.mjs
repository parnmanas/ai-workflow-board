// 회귀 가드 — 테스트가 부팅 포트를 다루는 방식 두 가지를 정적으로 막는다.
//
//   규칙 1 (ticket 5db0964a): 포트를 **산술로 파생**하지 마라.
//   규칙 2 (ticket f2d82793): 포트를 **고정 리터럴로 선언**하지 마라.
//
// 둘은 같은 결함의 두 얼굴이라 한 파일에 둔다 — 어느 쪽이든 "이 파일이 어느
// 번호를 잡는가" 가 실행 시점에야 정해지거나(1), 다른 파일·다른 세션·데스크톱
// 앱과 겹칠 수 있는 번호로 못박히거나(2) 한다. 정답은 양쪽 모두 `port: 0` 이다.
//
// ── 규칙 1: 산술 파생 ──────────────────────────────────────────────────────
//
// 테스트가 부팅 포트를 `BASE_PORT + 1` / `parseInt(process.env.PORT, 10) + 2` 처럼
// **산술로 파생**하면, 그렇게 실제로 점유되는 번호가 소스 어디에도 문자열로
// 존재하지 않는다. `grep -rn 7800 apps/server/test` 가 0건인데 그 포트를 물고
// 있으므로:
//
//   - 다른 파일이 같은 번호를 자기 기본 포트로 선언해도 아무도 눈치채지 못한다
//     (5db0964a 착수 시점 실측: consensus-gate 의 파생 7877 이
//     consensus-template-refresh 의 선언 포트와 이미 겹쳐 있었다).
//   - 데스크톱 앱이 인접 번호를 잡고 있으면 그대로 EADDRINUSE 로 죽는다. 그
//     파일이 pretest 청크에 있으면 run-suite 가 exit 1 을 내고 test·posttest
//     청크가 통째로 건너뛰어져 커버리지가 조용히 사라진다.
//   - bootApp 은 부팅할 때마다 process.env.PORT 를 **실제 바인딩된** 포트로
//     덮어쓴다. 그래서 같은 파일에서 env.PORT 기반 파생을 두 번 이상 하면 두
//     번째부터는 의도한 번호에서 밀린다(manager-update-approval 은 7933·7934 를
//     의도했지만 실제로는 7934·7937 을 잡고 있었다).
//
// 정답은 `bootApp({ port: 0 })` 이다 — OS 가 빈 포트를 고르고 bootApp 이 실제
// 바인딩된 포트를 돌려준다. raw express 라면 `app.listen(0)` +
// `server.address().port`. 이 규약은 helpers/boot.mjs 와 qa-flows/README.md 에
// 이미 적혀 있으므로 여기서는 그것을 강제하기만 한다.
//
// 순수 정적 스캔이다 — 앱 부팅도 서브프로세스도 없어서 매 `npm test` 에 얹어도
// 싸다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOP_LEVEL_DIR = __dirname;
const QA_FLOWS_DIR = path.join(__dirname, 'qa-flows');
const HELPERS_DIR = path.join(__dirname, 'helpers');
// 이 파일 자신은 스캔에서 뺀다 — 아래 비공허성 테스트가 금지 패턴을 픽스처
// 문자열로 들고 있어서 스스로에게 걸린다. test-registration-completeness 가
// 같은 이유로 쓰는 SELF_BASENAME 관용구와 동일하다. 이 파일은 앱을 부팅하지
// 않으므로 제외해도 실제로 점유되는 포트를 놓치지 않는다.
const SELF_BASENAME = path.basename(fileURLToPath(import.meta.url));

// 잡아야 하는 것: 포트를 담은 식별자에 정수를 더하는 식.
//   process.env.PORT + 1 / parseInt(process.env.PORT, 10) + 2 / Number(...) + 3
//   BASE_PORT + 1 / TEST_SERVER_PORT + 2 / port + 1
// 잡으면 안 되는 것: report/support 처럼 우연히 port 로 끝나는 단어, 그리고
// Date.now() + 60_000 같은 무관한 산술.
const PORT_ARITHMETIC_RE =
  /(?:\bPORT\b|\b[A-Z][A-Z0-9]*_PORT\b|\bport\b)\s*(?:,\s*\d+\s*)?\)*\s*\+\s*\d/;

// 주석 줄은 건너뛴다 — 이 파일과 boot.mjs·README 처럼 금지된 패턴을 **설명**하는
// 문서가 스스로 가드에 걸리면 안 된다.
function isCommentLine(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

// dir 를 인자로 받는다. 아래 비공허성 테스트가 실 test/ 디렉터리를 건드리지 않고
// 격리 tmpdir 로 같은 코드 경로를 그대로 구동하기 위해서다 — 합성 .test.mjs 를
// 잠깐이라도 실 test/ 에 쓰면 동시 실행 중인 test-registration-completeness 가
// "미등록 테스트 파일" 로 오탐한다.
// 두 규칙이 같은 순회를 쓴다 — 디렉터리 훑기, 자기 제외, 주석 건너뛰기가
// 규칙마다 따로 놀면 한쪽만 고쳐지고 다른 쪽이 조용히 stale 해진다.
function scanTestFiles(dir, rule, suffix = '.test.mjs') {
  const violations = [];
  let scannedFiles = 0;
  for (const entry of fs.readdirSync(dir).sort()) {
    if (!entry.endsWith(suffix)) continue;
    if (dir === TOP_LEVEL_DIR && entry === SELF_BASENAME) continue;
    scannedFiles += 1;
    const lines = fs.readFileSync(path.join(dir, entry), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (isCommentLine(line)) return;
      if (rule(line)) {
        violations.push(`${entry}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  return { violations, scannedFiles };
}

export function scanPortDerivations(dir) {
  return scanTestFiles(dir, (line) => PORT_ARITHMETIC_RE.test(line));
}

const REMEDY =
  '부팅 포트를 산술로 파생하지 마라 — bootApp({ port: 0 }) 으로 OS 에 빈 포트를 받고 ' +
  '반환된 port 를 써라 (raw express 는 app.listen(0) + server.address().port). ticket 5db0964a';

test('test/*.test.mjs 어디에도 부팅 포트 산술 파생이 없다', () => {
  const { violations, scannedFiles } = scanPortDerivations(TOP_LEVEL_DIR);
  // 스캔 경로가 틀려 0 파일을 읽고도 통과하는 공허한 green 을 막는다.
  assert.ok(scannedFiles > 50, `top-level 스캔이 ${scannedFiles} 개 파일만 봤다 — 경로가 틀렸다`);
  assert.deepEqual(violations, [], `${REMEDY}\n${violations.join('\n')}`);
});

test('test/qa-flows/*.test.mjs 어디에도 부팅 포트 산술 파생이 없다', () => {
  const { violations, scannedFiles } = scanPortDerivations(QA_FLOWS_DIR);
  assert.ok(scannedFiles > 50, `qa-flows 스캔이 ${scannedFiles} 개 파일만 봤다 — 경로가 틀렸다`);
  assert.deepEqual(violations, [], `${REMEDY}\n${violations.join('\n')}`);
});

// 비공허성 — 위 두 테스트는 "위반이 0건" 을 단언하므로, 스캔부(readdir + 정규식)가
// 통째로 망가져도 그대로 green 이다. 그래서 스캔 술어를 실제로 만족하는 합성
// 파일을 격리 디렉터리에 넣고 가드가 정말 반응하는지 확인한다.
test('비공허성: 파생을 담은 합성 파일을 스캔하면 실제로 잡힌다 (격리 tmpdir)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-port-derivation-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(
    path.join(dir, 'env-port-derivation.test.mjs'),
    "const { app, port } = await bootApp({ port: parseInt(process.env.PORT, 10) + 1 });\n",
  );
  fs.writeFileSync(
    path.join(dir, 'base-port-derivation.test.mjs'),
    'const { app, port } = await bootApp({ port: BASE_PORT + 2 });\n',
  );

  const { violations, scannedFiles } = scanPortDerivations(dir);
  assert.equal(scannedFiles, 2);
  assert.equal(violations.length, 2, `두 파생 형태 모두 잡혀야 한다: ${JSON.stringify(violations)}`);
  assert.match(violations[0], /^base-port-derivation\.test\.mjs:1:/);
  assert.match(violations[1], /^env-port-derivation\.test\.mjs:1:/);
});

test('비공허성 반대편: 정상 코드와 설명 주석은 잡히지 않는다', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-port-derivation-guard-clean-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(
    path.join(dir, 'clean.test.mjs'),
    [
      // 픽스처에 실제 포트 번호를 박지 않는다 — "어느 파일이 어느 포트를 선언하나"
      // 를 세는 조사에 이 파일이 가짜 선언으로 끼어든다.
      'process.env.PORT = process.env.TEST_SERVER_PORT || FALLBACK_PORT;',
      'const { app, port } = await bootApp({ port: 0 });',
      'const base = `http://localhost:${port}`;',
      'const deadline = Date.now() + 10 * 60_000;',
      "const rows = await repo.find({ where: { action: 'support' } });",
      '// 예전에는 bootApp({ port: BASE_PORT + 1 }) 이었다 — 주석은 잡히면 안 된다.',
    ].join('\n') + '\n',
  );

  const { violations } = scanPortDerivations(dir);
  assert.deepEqual(violations, [], '정규식이 과잉 매칭하면 정상 코드까지 막는다');
});

// ── 규칙 2: 고정 포트 리터럴 (ticket f2d82793) ─────────────────────────────
//
// 규칙 1 을 지켜 파생을 없애도, 각 파일이 **선언한** 기본 포트가 고정 리터럴이면
// 문제가 남는다. f2d82793 착수 시점 실측: 152 개 파일이 포트를 선언했고 고유값
// 105 개 중 32 개가 중복이었다(최다 7842 는 7 개 파일이 같이 썼다). 순차 러너가
// 가려주고 있었을 뿐이고, 별도 세션이 겹치거나 데스크톱 앱이 그 번호를 잡으면
// 그대로 EADDRINUSE 다. "포트 할당 대장" 은 실재하지 않았다 — 사람이 손으로
// 유지하는 대장은 반드시 어긋난다.
//
// 그래서 번호를 다시 나눠주는 대신 **번호 자체를 없앤다**: 선언은 전부 0 이고
// 실제 번호는 OS 가 정한다. env 로 덮어쓰는 길(`X_PORT=7842`)은 남겨두어 특정
// 번호에 붙어 디버깅하는 것은 여전히 가능하다 — 막는 것은 **소스에 박힌 기본값**
// 뿐이다.
//
// 포트를 env 로만 받고 바인딩 핸들을 안 주는 대상(dist/mcp-server.js)은 예외적으로
// helpers/boot.mjs 의 findFreePort() 를 쓴다 — 그것도 리터럴이 아니다.
// 구조적 형태 — 포트 자리에 리터럴이 온 것이 문법으로 확정된다. 줄에 "port"
// 라는 단어가 없어도(예: `app.listen(7799)`) 위반이다.
const PORT_LITERAL_STRUCTURAL_RE = new RegExp(
  [
    String.raw`\bport:\s*\d{4,5}\b`,                          // bootApp({ port: 7896 })
    String.raw`\bport\s*=\s*\d{4,5}\b`,                       // function bootApp({ port = 7800 })
    String.raw`\.listen\(\s*\d{4,5}\b`,                       // app.listen(7799)
    String.raw`process\.env\.[A-Z0-9_]*PORT\s*=\s*'?\d{4,5}\b`, // process.env.PORT = '7842'
  ].join('|'),
);

// env 폴백 형태 — `|| '7842'` 는 그 자체로는 포트인지 알 수 없으므로, 줄이 포트를
// 다루고 있을 때만 위반으로 본다. 이 한정이 없으면 `?? 3000` 같은 무관한 기본값이
// 걸려 가드가 잡음이 되고, 잡음이 되면 결국 allowlist 로 무력화된다.
const PORT_LITERAL_FALLBACK_RE = /\|\|\s*'?\d{4,5}'?/;
const PORT_WORD_RE = /\bPORT\b|\b[A-Z][A-Z0-9]*_PORT\b|\bport\b/;

// 이 가드가 막는 것은 **이 프로세스가 바인딩하는** 포트다. 밖으로 붙으러 가는
// 클라이언트 포트(Postgres 5432 등)는 우리가 고르는 값이 아니라 상대가 이미 듣고
// 있는 값이라, 0 으로 둘 수도 없고 겹침 문제도 없다. `DB_PORT` 로 오는 값이 그것이다.
const OUTBOUND_CLIENT_PORT_RE = /\bDB_PORT\b/;

// 한 줄짜리 예외는 목록이 아니라 **그 줄에** 적는다. 파일명·줄번호 allowlist 는
// 코드가 움직이면 조용히 엉뚱한 줄을 면제하지만, 인라인 마커는 절대 어긋나지
// 않고 리뷰어가 예외를 바로 옆에서 읽는다. 지금 쓰이는 곳은 "포트처럼 생겼지만
// 아무도 바인딩하지 않는 설정 픽스처" 하나다.
const ALLOW_MARKER = 'port-guard-allow';

function hasFixedPortLiteral(line) {
  if (line.includes(ALLOW_MARKER)) return false;
  if (OUTBOUND_CLIENT_PORT_RE.test(line)) return false;
  if (PORT_LITERAL_STRUCTURAL_RE.test(line)) return true;
  return PORT_WORD_RE.test(line) && PORT_LITERAL_FALLBACK_RE.test(line);
}

const LITERAL_REMEDY =
  '테스트 부팅 포트를 고정 리터럴로 선언하지 마라 — 기본값은 0 으로 두고(OS 가 빈 포트 배정) ' +
  "bootApp 이 돌려주는 port 를 써라. 고정이 필요하면 env(`X_PORT=7842`)로 덮어써라. ticket f2d82793";

test('test/*.test.mjs 어디에도 고정 부팅 포트 리터럴이 없다', () => {
  const { violations, scannedFiles } = scanTestFiles(TOP_LEVEL_DIR, hasFixedPortLiteral);
  assert.ok(scannedFiles > 50, `top-level 스캔이 ${scannedFiles} 개 파일만 봤다 — 경로가 틀렸다`);
  assert.deepEqual(violations, [], `${LITERAL_REMEDY}\n${violations.join('\n')}`);
});

test('test/qa-flows/*.test.mjs 어디에도 고정 부팅 포트 리터럴이 없다', () => {
  const { violations, scannedFiles } = scanTestFiles(QA_FLOWS_DIR, hasFixedPortLiteral);
  assert.ok(scannedFiles > 50, `qa-flows 스캔이 ${scannedFiles} 개 파일만 봤다 — 경로가 틀렸다`);
  assert.deepEqual(violations, [], `${LITERAL_REMEDY}\n${violations.join('\n')}`);
});

test('비공허성: 고정 리터럴 5형태를 담은 합성 파일은 전부 잡힌다 (격리 tmpdir)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-port-literal-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // f2d82793 이 실제로 걷어낸 12 개 형태를 대표하는 5 가지. 픽스처 파일명을
  // 형태별로 나눠 어느 형태가 안 잡혔는지 실패 메시지에서 바로 보이게 한다.
  const fixtures = {
    'a-env-fallback.test.mjs': "process.env.PORT = process.env.QA_SOMETHING_PORT || '7842';\n",
    'b-const-parseint.test.mjs': "const BASE_PORT = parseInt(process.env.QA_X_PORT || '7861', 10);\n",
    'c-const-number.test.mjs': 'const BASE_PORT = Number(process.env.TEST_SERVER_PORT || 7935);\n',
    'd-bootapp-literal.test.mjs': 'const { app, port } = await bootApp({ port: 7896 });\n',
    'e-raw-listen.test.mjs': 'const server = app.listen(7799);\n',
  };
  for (const [name, body] of Object.entries(fixtures)) {
    fs.writeFileSync(path.join(dir, name), body);
  }

  const { violations, scannedFiles } = scanTestFiles(dir, hasFixedPortLiteral);
  assert.equal(scannedFiles, Object.keys(fixtures).length);
  assert.equal(
    violations.length,
    Object.keys(fixtures).length,
    `고정 리터럴 5형태가 전부 잡혀야 한다 — 잡힌 것: ${JSON.stringify(violations)}`,
  );
});

test('비공허성 반대편: port: 0 과 무관한 4자리 숫자는 잡히지 않는다', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-port-literal-guard-clean-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(
    path.join(dir, 'clean.test.mjs'),
    [
      // 이 티켓이 확정한 정상형 — 선언은 0, 실제 번호는 반환값에서 온다.
      "process.env.PORT = process.env.QA_SOMETHING_PORT || '0';",
      'const { app, port } = await bootApp({ port: 0 });',
      'const server = app.listen(0);',
      'const REQUESTED_PORT = Number(process.env.TEST_SERVER_PORT || 0);',
      'const base = `http://localhost:${port}`;',
      // 포트와 무관한 4~5 자리 숫자가 같은 줄의 port 라는 단어 때문에 잡히면 안 된다.
      'await waitForPortToDrain({ timeoutMs: 20000 });',
      "const res = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(15000) });",
      "assert.equal(report.protocolVersion, '2024-11-05');",
      // 아웃바운드 DB 클라이언트 포트는 우리가 바인딩하는 값이 아니므로 면제다.
      "port: parseInt(process.env.DB_PORT || '5432', 10),",
    ].join('\n') + '\n',
  );

  const { violations } = scanTestFiles(dir, hasFixedPortLiteral);
  assert.deepEqual(violations, [], '정규식이 과잉 매칭하면 정상 코드까지 막는다');
});

test('예외 마커는 그 줄만 면제한다 (격리 tmpdir)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-port-literal-guard-marker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(
    path.join(dir, 'marker.test.mjs'),
    [
      `    port: 8000, // ${ALLOW_MARKER}: 바인딩하지 않는 설정 픽스처`,
      '    port: 8001,',
    ].join('\n') + '\n',
  );

  const { violations } = scanTestFiles(dir, hasFixedPortLiteral);
  assert.equal(violations.length, 1, `마커가 없는 줄만 남아야 한다: ${JSON.stringify(violations)}`);
  assert.match(violations[0], /marker\.test\.mjs:2:/, '마커 줄(1행)이 아니라 다음 줄(2행)이 잡혀야 한다');
});

// helpers/ 는 .test.mjs 가 아니라 위 두 스캔이 닿지 않는다. 그런데 bootApp 의
// **기본 포트**가 사는 곳이 정확히 여기라서, 여기가 비어 있으면 "선언은 다 0" 이라는
// 이 티켓의 결론이 헬퍼 한 줄로 조용히 무너진다.
test('test/helpers/*.mjs 에도 고정 부팅 포트 리터럴이 없다 (bootApp 기본값 포함)', () => {
  const { violations, scannedFiles } = scanTestFiles(HELPERS_DIR, hasFixedPortLiteral, '.mjs');
  assert.ok(scannedFiles > 3, `helpers 스캔이 ${scannedFiles} 개 파일만 봤다 — 경로가 틀렸다`);
  assert.deepEqual(violations, [], `${LITERAL_REMEDY}\n${violations.join('\n')}`);
});

test('비공허성: 파라미터 기본값 형태도 잡힌다 (격리 tmpdir)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-port-literal-guard-default-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(
    path.join(dir, 'helper-default.mjs'),
    'export async function bootApp({ port = 7800, logger = false } = {}) {\n',
  );
  fs.writeFileSync(
    path.join(dir, 'helper-clean.mjs'),
    'export async function bootApp({ port = 0, logger = false } = {}) {\n',
  );

  const { violations, scannedFiles } = scanTestFiles(dir, hasFixedPortLiteral, '.mjs');
  assert.equal(scannedFiles, 2);
  assert.equal(violations.length, 1, `기본값 리터럴만 잡혀야 한다: ${JSON.stringify(violations)}`);
  assert.match(violations[0], /^helper-default\.mjs:1:/);
});
