// 의존성 보안 감사 회귀 가드 — GHSA-qwww-vcr4-c8h2
// ("React Router: RSC Mode CSRF Bypass Allows Action Execution Before 400 Response")
//
// **2026-08-08 상태 변경 — 이 건은 더 이상 "승인된 예외"가 아니라 해소됐다.**
// GitHub 이 2026-08-07T18:16Z 에 advisory 를 개정하면서 7.x 취약 범위가
// `>= 7.12.0, < 8.3.0` → `>= 7.12.0, < 7.18.2` 로 좁혀졌고, 7.x 계열의
// first patched version 이 **7.18.2** 로 지정됐다. 이 저장소는 이미
// 7.18.2 를 물고 있었으므로(= 패치 버전) `npm audit` 이 0건으로 떨어졌다.
// `react-router-dom` 은 advisory 대상에서 아예 빠졌다.
//
// 그래서 방어의 무게중심이 옮겨졌다. 예전 근거는 "RSC 를 안 쓰니 해당 없음"
// 이었지만, 지금 실제로 우리를 지키는 것은 **7.18.2 이상이라는 사실**이다.
// 누군가 7.18.1 이하로 되돌리면(롤백, resolution 고정, lockfile 수동 편집)
// 취약점이 그대로 되살아난다 — 그리고 그건 RSC 를 쓰는지와 무관하게
// advisory 범위 안이다. 아래 `react-router stays at or above the patched
// 7.18.2` 가 그 바닥을 지킨다.
//
// RSC 스캔 단언들은 그대로 남겨둔다. 심층 방어이고(패치 이전 범위로
// 내려갔을 때 실제 피해 여부를 가르는 조건이 여전히 "RSC 사용 여부"다),
// 비용은 fs 스캔 몇 번뿐이다.
//
// 실패하면 테스트를 완화하지 말고 감사 문서
// (`docs/audit/2026-08-dependency-security-audit.md`) 의 판단 근거부터 볼 것.

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

// ─────────────────────────────────────────────────────────────────────────────
// 버전 바닥 — GHSA-qwww-vcr4-c8h2 의 7.x first patched version
// ─────────────────────────────────────────────────────────────────────────────

// advisory 개정 후의 7.x 취약 범위는 `>= 7.12.0, < 7.18.2` 다. 즉 7.18.2 가
// 바닥이고, 그 아래로 내려가는 순간(수동 다운그레이드 / lockfile 편집 /
// resolution 고정) 다시 취약 범위 안이다. 8.x 로 올라가는 경우에는 8.3.0 이
// 바닥이라는 것도 같이 강제한다 — 8.0.0~8.2.x 는 별도 취약 구간이다.
const PATCHED_7X = [7, 18, 2];
const PATCHED_8X = [8, 3, 0];

function parseVersion(v) {
  return v.split('-')[0].split('.').map(Number);
}

function gte(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

test('react-router stays at or above the patched 7.18.2', () => {
  const lock = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'package-lock.json'), 'utf8'),
  );

  const resolved = Object.entries(lock.packages ?? {})
    .filter(([name]) => /(^|\/)node_modules\/react-router(-dom)?$/.test(name))
    .map(([name, meta]) => ({ name, version: meta.version }));

  // 가드가 죽은 채 초록불만 내는 것 방지.
  assert.ok(
    resolved.length > 0,
    'no react-router entry found in package-lock.json — this guard is reading the wrong lockfile',
  );

  const offenders = resolved.filter(({ version }) => {
    const parsed = parseVersion(version);
    const floor = parsed[0] >= 8 ? PATCHED_8X : PATCHED_7X;
    return !gte(parsed, floor);
  });

  assert.deepEqual(
    offenders.map((o) => `${o.name}@${o.version}`),
    [],
    'react-router resolved below the GHSA-qwww-vcr4-c8h2 patched version (7.18.2 for 7.x, ' +
      '8.3.0 for 8.x) — the advisory applies again. Do not relax this test; ' +
      'see docs/audit/2026-08-dependency-security-audit.md',
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
