// 의존성 보안 감사 회귀 가드 — GHSA-qwww-vcr4-c8h2
// ("React Router: RSC Mode CSRF Bypass Allows Action Execution Before 400 Response")
//
// `react-router` / `react-router-dom` 7.12.0 ~ 8.2.x 는 위 advisory(high)의
// 취약 범위이고, 패치 릴리스는 8.3.0 하나뿐이다. 8.3.0 의 peer 는
// `react >= 19.2.7` 이라 React 18.3 을 쓰는 이 클라이언트는 올라갈 수 없다.
// 그래서 `docs/audit/2026-08-dependency-security-audit.md` 는 이 2건을
// **"해당 없음(not applicable)"** 으로 승인하고 남겨두었다.
//
// 그 승인은 단 하나의 사실에 전적으로 기대고 있다:
//
//     apps/client 는 취약 경로인 unstable RSC API 를 전혀 쓰지 않는다.
//
// advisory 본문도 "This only affects your application if you are using the
// unstable RSC APIs" 라고 명시한다. 즉 누군가 RSC/SSR 라우팅을 도입하는 순간
// 이 감사 결론은 조용히 거짓이 되고, 승인된 예외가 실재하는 high 취약점으로
// 바뀐다 — 그런데 그걸 알려주는 장치가 이 파일 이전에는 없었다(감사 문서의
// "재검토 트리거"는 산문일 뿐 아무것도 강제하지 않았다).
//
// 이 테스트는 그 산문을 기계 검사로 바꾼다. 실패하면 업그레이드 회피가
// 더 이상 정당하지 않다는 뜻이므로, 테스트를 완화하지 말고
// 감사 문서의 "재검토 트리거" 절차를 밟을 것:
//   React 19 상향 → `react-router@^8.3.0` 으로 올리거나, RSC 도입을 되돌린다.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_SRC = path.resolve(__dirname, '..', 'src');
const SERVER_SRC = path.resolve(__dirname, '..', '..', 'server', 'src');

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);

function collectSources(dir) {
  const files = [];
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectSources(full));
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(full);
  }
  return files;
}

const CLIENT_FILES = collectSources(CLIENT_SRC).map((file) => ({
  file: path.relative(path.resolve(__dirname, '..', '..', '..'), file),
  source: fs.readFileSync(file, 'utf8'),
}));

// 스캔 대상이 비면 아래 단언들이 전부 공허하게 통과한다 — 가드가 죽은 채로
// 초록불만 내는 상황을 먼저 배제한다.
test('guard actually has client sources to scan', () => {
  assert.ok(
    CLIENT_FILES.length > 50,
    `expected to scan the client source tree, found ${CLIENT_FILES.length} files under ${CLIENT_SRC}`,
  );
  const routerUsers = CLIENT_FILES.filter(({ source }) => source.includes('react-router'));
  assert.ok(
    routerUsers.length > 0,
    'no file imports react-router at all — this guard is scanning the wrong tree',
  );
});

// 취약 경로의 진입점. `react-router/rsc` 서브패스나 RSC 전용 심볼이 하나라도
// 들어오면 advisory 가 실제로 적용되기 시작한다.
const RSC_ENTRYPOINTS = [
  'react-router/rsc',
  'react-router-dom/rsc',
  '@vitejs/plugin-rsc',
  '@react-router/dev',
  '@react-router/node',
  '@react-router/serve',
];

const RSC_SYMBOLS = [
  'matchRSCServerRequest',
  'routeRSCServerRequest',
  'createCallServer',
  'RSCHydratedRouter',
  'RSCStaticRouter',
  'getRSCStream',
  'ServerRouter',
];

test('client never imports a React Router RSC entrypoint', () => {
  const hits = [];
  for (const { file, source } of CLIENT_FILES) {
    for (const entry of RSC_ENTRYPOINTS) {
      if (new RegExp(`['"\`]${entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:['"\`/])`).test(source)) {
        hits.push(`${file} -> ${entry}`);
      }
    }
  }
  assert.deepEqual(
    hits,
    [],
    'RSC entrypoint imported — GHSA-qwww-vcr4-c8h2 now APPLIES to this app. ' +
      `See docs/audit/2026-08-dependency-security-audit.md before touching this test: ${hits.join(', ')}`,
  );
});

test('client never references a React Router RSC server symbol', () => {
  const hits = [];
  for (const { file, source } of CLIENT_FILES) {
    for (const symbol of RSC_SYMBOLS) {
      // React Router 는 같은 심볼을 `unstable_` 접두사로도 노출한다.
      // `\b` 는 `_RSCHydratedRouter` 앞에서 성립하지 않으므로 `_` 도 경계로 친다.
      if (new RegExp(`(?:\\b|_)${symbol}\\b`).test(source)) hits.push(`${file} -> ${symbol}`);
    }
  }
  assert.deepEqual(
    hits,
    [],
    'React Router RSC server API referenced — GHSA-qwww-vcr4-c8h2 now APPLIES to this app. ' +
      `See docs/audit/2026-08-dependency-security-audit.md before touching this test: ${hits.join(', ')}`,
  );
});

// advisory 가 "unstable RSC APIs" 라고 부르는 것들은 전부 `unstable_` 접두사로
// 노출된다. 개별 심볼을 일일이 나열하는 대신 접두사 자체를 막는다.
test('client imports no unstable_* symbol from react-router', () => {
  const importRe = /import\s+([\s\S]*?)\s+from\s+['"`](react-router(?:-dom)?)(\/[^'"`]*)?['"`]/g;
  const hits = [];
  for (const { file, source } of CLIENT_FILES) {
    for (const match of source.matchAll(importRe)) {
      const [, clause, pkg, subpath] = match;
      if (subpath) hits.push(`${file} -> ${pkg}${subpath} (subpath import)`);
      for (const unstable of clause.matchAll(/\bunstable_[A-Za-z0-9_]*/g)) {
        hits.push(`${file} -> ${pkg}:${unstable[0]}`);
      }
    }
  }
  assert.deepEqual(
    hits,
    [],
    'unstable/subpath React Router import — the GHSA-qwww-vcr4-c8h2 exemption assumes neither exists: ' +
      hits.join(', '),
  );
});

// 취약 경로는 서버측 RSC 핸들러다. 서버는 NestJS 이고 라우팅에 관여하지
// 않는다는 사실이 "클라이언트 전용 SPA" 근거의 나머지 절반이다.
test('server carries no react-router dependency', () => {
  const serverPkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', '..', 'server', 'package.json'), 'utf8'),
  );
  const declared = { ...serverPkg.dependencies, ...serverPkg.devDependencies };
  const routerDeps = Object.keys(declared).filter((name) => name.includes('react-router'));
  assert.deepEqual(routerDeps, [], `apps/server declares react-router: ${routerDeps.join(', ')}`);

  const hits = collectSources(SERVER_SRC)
    .filter((file) => fs.readFileSync(file, 'utf8').includes('react-router'))
    .map((file) => path.relative(path.resolve(__dirname, '..', '..', '..'), file));
  assert.deepEqual(hits, [], `apps/server source references react-router: ${hits.join(', ')}`);
});
