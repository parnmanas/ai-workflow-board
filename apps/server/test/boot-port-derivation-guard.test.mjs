// 회귀 가드 — ticket 5db0964a.
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
export function scanPortDerivations(dir) {
  const violations = [];
  let scannedFiles = 0;
  for (const entry of fs.readdirSync(dir).sort()) {
    if (!entry.endsWith('.test.mjs')) continue;
    if (dir === TOP_LEVEL_DIR && entry === SELF_BASENAME) continue;
    scannedFiles += 1;
    const lines = fs.readFileSync(path.join(dir, entry), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (isCommentLine(line)) return;
      if (PORT_ARITHMETIC_RE.test(line)) {
        violations.push(`${entry}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  return { violations, scannedFiles };
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
