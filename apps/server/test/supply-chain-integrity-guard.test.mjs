// 공급망 무결성 회귀 가드 — 2026-08-07 의존성 보안 감사에서 추가.
// 상세 근거는 `docs/audit/2026-08-dependency-security-audit.md` → 재검증 로그.
//
// `npm audit` 은 "lockfile 에 적힌 버전"에 취약점이 있는지만 본다. 그런데
// 감사한 lockfile 이 실제로 배포/설치되는 트리와 같다는 보장은 audit 이
// 해주지 않는다. 이 가드는 그 보장을 성립시키는 세 가지 전제를 정적으로
// 강제한다 — 앱을 띄우지 않고 fs + JSON 파싱만 하므로 매 `npm test` 에
// 돌려도 싸다.
//
//   1. Dockerfile 이 의존성을 `npm ci` 로만 설치한다 (lockfile 강제).
//   2. lockfile 의 모든 엔트리가 registry.npmjs.org 에서 https 로 resolve 되고
//      integrity 해시를 갖는다 (dependency confusion / tarball 주입 차단).
//   3. install script 를 갖는 패키지가 알려진 목록을 벗어나지 않는다.
//   4. 우리가 **발행하는** 패키지(awb-agent-manager)가 provenance 와 함께 나간다
//      — 위 1~3 은 "받는 쪽" 방어, 이건 "주는 쪽" 방어다 (2026-08-10 추가).
//   5. 발행 가능한 워크스페이스가 그 하나뿐이고, 그 tarball 이 `files` 로 좁혀진다
//      (2026-08-15 추가).
//   6. 그 provenance 를 매니저 self-update 가 실제로 **검증**한다 — 증명을 만들어만
//      놓고 아무도 읽지 않으면 방어가 아니다 (2026-08-15 추가).
//
// 깨졌을 때 테스트를 완화하지 말고, 위 감사 문서의 판단 근거부터 다시 볼 것.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DOCKERFILE = path.join(REPO_ROOT, 'Dockerfile');
const ROOT_PKG = path.join(REPO_ROOT, 'package.json');
const LOCKFILE = path.join(REPO_ROOT, 'package-lock.json');
const PUBLISH_WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'publish-agent-manager.yml');
const AGENT_MANAGER_PKG = path.join(REPO_ROOT, 'apps', 'agent-manager', 'package.json');

// ─────────────────────────────────────────────────────────────────────────────
// 1. Dockerfile — 배포 이미지는 lockfile 이 강제된 트리여야 한다
// ─────────────────────────────────────────────────────────────────────────────

// `npm install` 은 lockfile 을 제안으로만 취급한다. 같은 커밋을 두 번 빌드해도
// semver 범위 안에서 다른 버전이 잡힐 수 있고, 컨테이너 안의 lockfile 자체를
// 덮어쓴다. 2026-08-07 감사 전까지 runner 스테이지가 정확히 그 상태였다
// (`RUN npm install --omit=dev --workspace=server`) — 감사한 트리와 배포된
// 트리가 같다는 보장이 없었다.
test('Dockerfile installs dependencies only through `npm ci`', () => {
  const lines = fs.readFileSync(DOCKERFILE, 'utf8').split('\n');

  const installLines = [];
  const ciLines = [];
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    if (line.startsWith('#')) continue;
    // `RUN npm install ...` / `&& npm install ...` 둘 다 잡는다.
    // `npm install -g <tool>` 처럼 lockfile 과 무관한 전역 설치는 제외.
    if (/\bnpm\s+install\b/.test(line) && !/\bnpm\s+install\b[^\n]*\s-g\b/.test(line)) {
      installLines.push(`${i + 1}: ${line}`);
    }
    if (/\bnpm\s+ci\b/.test(line)) ciLines.push(`${i + 1}: ${line}`);
  }

  assert.deepEqual(
    installLines,
    [],
    'Dockerfile uses `npm install` for a dependency install — the deployed tree is then ' +
      'no longer provably the audited lockfile tree. Use `npm ci`. ' +
      `See docs/audit/2026-08-dependency-security-audit.md: ${installLines.join(' | ')}`,
  );

  // 가드가 죽은 채 초록불만 내는 것 방지 — Dockerfile 이 실제로 의존성을
  // 설치하고는 있어야 한다.
  assert.ok(
    ciLines.length >= 2,
    `expected at least 2 \`npm ci\` invocations (deps + runner stage), found ${ciLines.length}`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. lockfile — 전 엔트리가 공식 registry + integrity 해시
// ─────────────────────────────────────────────────────────────────────────────

const LOCK = JSON.parse(fs.readFileSync(LOCKFILE, 'utf8'));
// workspace 링크(`apps/*`)는 registry 에서 오지 않으므로 resolved/integrity 가
// 없는 게 정상이다. 그 외 전부가 검사 대상.
const REGISTRY_ENTRIES = Object.entries(LOCK.packages ?? {}).filter(
  ([name, meta]) => name !== '' && !meta.link && !name.startsWith('apps/'),
);

test('guard actually has lockfile entries to scan', () => {
  assert.ok(
    REGISTRY_ENTRIES.length > 400,
    `expected the full dependency tree, found ${REGISTRY_ENTRIES.length} entries in ${LOCKFILE}`,
  );
});

// 하나라도 git+ / http:// / 사설 registry / 임의 tarball URL 로 새면 그 패키지는
// npm advisory DB 로 감사되지 않고, 소유자가 조용히 내용을 바꿔치기할 수 있다.
test('every lockfile entry resolves from registry.npmjs.org over https', () => {
  const offenders = REGISTRY_ENTRIES.filter(
    ([, meta]) => !meta.resolved || !meta.resolved.startsWith('https://registry.npmjs.org/'),
  ).map(([name, meta]) => `${name} -> ${meta.resolved ?? '(no resolved field)'}`);

  assert.deepEqual(
    offenders,
    [],
    'lockfile entry resolved outside https://registry.npmjs.org — such a package is not covered ' +
      `by npm audit and can be swapped out by its host: ${offenders.join(', ')}`,
  );
});

// integrity 가 없으면 `npm ci` 가 tarball 내용을 검증하지 못한다 —
// 위 `npm ci` 강제가 무의미해지는 구멍.
test('every lockfile entry carries an integrity hash', () => {
  const offenders = REGISTRY_ENTRIES.filter(([, meta]) => !meta.integrity).map(
    ([name, meta]) => `${name}@${meta.version ?? '?'}`,
  );

  assert.deepEqual(
    offenders,
    [],
    `lockfile entry without an integrity hash — \`npm ci\` cannot verify its tarball: ${offenders.join(', ')}`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. install script — 설치 시점에 임의 코드를 실행하는 패키지 목록 고정
// ─────────────────────────────────────────────────────────────────────────────

// install script 는 `npm ci` 만으로도 실행되는 임의 코드 실행 지점이다.
// 전면 금지(`--ignore-scripts`)는 esbuild 가 깨져서 불가하므로, 대신 "새로
// 생긴 것"을 알아채도록 목록을 고정한다. 여기 목록이 늘어나야 한다면
// 그 패키지가 왜 설치 시점에 코드를 돌려야 하는지 확인하고 추가할 것.
const ALLOWED_INSTALL_SCRIPTS = new Set([
  'esbuild', // 플랫폼별 바이너리 배치 — vite/tsx 빌드 체인 필수
  'fsevents', // macOS 전용 optional native watcher
  '@scarf/scarf', // swagger-ui-dist 전이 telemetry — 아래 테스트에서 opt-out 강제
]);

test('no unexpected package runs an install script', () => {
  const found = REGISTRY_ENTRIES.filter(([, meta]) => meta.hasInstallScript).map(([name]) =>
    // `node_modules/tsx/node_modules/fsevents` → `fsevents`
    name.replace(/^.*node_modules\//, ''),
  );

  const unexpected = [...new Set(found)].filter((name) => !ALLOWED_INSTALL_SCRIPTS.has(name));
  assert.deepEqual(
    unexpected,
    [],
    'new package with an install script — it runs arbitrary code on every `npm ci`, including ' +
      `in CI and in the Docker build. Review before allowlisting: ${unexpected.join(', ')}`,
  );
});

// `@scarf/scarf` 의 postinstall 은 설치될 때마다 scarf.sh 로 비콘을 쏜다
// (패키지명/버전/OS/arch/CI 여부). 취약점은 아니지만 빌드 컨테이너에서
// 나가는 불필요한 아웃바운드이고, 끄는 비용이 root package.json 3줄이다.
// scarf 의 opt-out 경로는 `report.js` 가 읽는 rootPackage.scarfSettings.enabled === false.
test('root package.json opts out of @scarf/scarf install-time telemetry', () => {
  const pkg = JSON.parse(fs.readFileSync(ROOT_PKG, 'utf8'));
  assert.equal(
    pkg.scarfSettings?.enabled,
    false,
    'root package.json must set `scarfSettings.enabled: false` — @scarf/scarf ships a postinstall ' +
      'beacon and is present in the production runtime tree (via swagger-ui-dist)',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. 발행 측 공급망 — awb-agent-manager 는 provenance 와 함께 나가야 한다
// ─────────────────────────────────────────────────────────────────────────────

// 위 가드들은 전부 "우리가 남의 패키지를 받을 때"의 방어다. 그런데 이 저장소는
// npm 에 `awb-agent-manager` 를 **발행**하고, live host 들이 그걸 `npm i -g` 로
// 깔아서 fleet 전체를 돌린다 — 즉 우리 패키지가 남의 신뢰 루트다.
// provenance 없이 발행하면 NPM_TOKEN 이 유출됐을 때 공격자가 같은 이름으로 임의
// tarball 을 올려도 소비자가 구분할 수단이 없다. `--provenance` 는 Sigstore 에
// "이 tarball 은 이 repo 의 이 커밋에서 이 워크플로로 빌드됐다"는 서명을 남기고,
// 소비자는 `npm audit signatures` 로 검증한다.
// (2026-08-10 감사에서 발견: 워크플로에 --provenance 도 id-token 권한도 없었다.)

/** YAML 주석(`#` 로 시작하는 줄)을 제거한다 — 주석 안의 `--provenance` 가 통과시키면 안 된다. */
function stripYamlComments(text) {
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

test('agent-manager publish workflow publishes with npm provenance', () => {
  const yaml = stripYamlComments(fs.readFileSync(PUBLISH_WORKFLOW, 'utf8'));

  // 실제로 **실행되는** 줄만 본다. `name: compute version + npm publish` 같은
  // job/step 표시 이름에도 "npm publish" 가 들어가므로 단순 substring 은 오탐이다.
  // 실행 형태는 둘 뿐 — `run: npm publish …` (한 줄) 또는 `run: |` 블록 안의 줄.
  const publishLines = yaml
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^(run:\s*)?npm publish\b/.test(l));

  assert.ok(
    publishLines.length > 0,
    'no `npm publish` invocation found in publish-agent-manager.yml — this guard has gone stale, ' +
      'update it to match however the package is published now',
  );

  const missing = publishLines.filter((l) => !l.includes('--provenance'));
  assert.deepEqual(
    missing,
    [],
    'every `npm publish` in publish-agent-manager.yml must pass `--provenance` so consumers can ' +
      `verify the tarball against this repo via \`npm audit signatures\`: ${missing.join(' | ')}`,
  );
});

// --provenance 는 OIDC 토큰 없이는 publish 를 **실패**시킨다. 두 설정은 항상 같이
// 움직여야 하므로 별도 assert 로 묶어둔다.
test('publish workflow grants the id-token permission provenance requires', () => {
  const yaml = stripYamlComments(fs.readFileSync(PUBLISH_WORKFLOW, 'utf8'));
  assert.match(
    yaml,
    /^\s*id-token:\s*write\s*$/m,
    'publish-agent-manager.yml passes `npm publish --provenance`, which mints a Sigstore ' +
      'attestation from a GitHub OIDC token — without `permissions: id-token: write` the ' +
      'publish step fails outright',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. CI 토큰 blast radius — 모든 워크플로는 permissions 를 명시해야 한다
// ─────────────────────────────────────────────────────────────────────────────

// (2026-08-12 감사에서 발견: ci.yml 에 permissions 블록이 아예 없었다.)
//
// `permissions:` 가 없는 워크플로의 GITHUB_TOKEN 은 저장소 기본값을 물려받는다.
// 기본값이 read-write 인 저장소에서 ci.yml 은 `npm ci`(서드파티 install script) 와
// PR 브랜치 테스트 코드를 write 토큰과 같은 프로세스 트리에서 돌리게 된다 —
// 의존성 하나만 탈취돼도 main push / 릴리스 조작이 가능해진다.
//
// 저장소 설정(기본 권한)은 이 저장소 밖에서 바뀔 수 있고 코드 리뷰에도 안 잡히므로,
// 방어는 반드시 워크플로 파일 안에 선언으로 박혀 있어야 한다.

const WORKFLOW_DIR = path.join(REPO_ROOT, '.github', 'workflows');

test('guard actually has workflows to scan', () => {
  const files = fs.readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f));
  assert.ok(
    files.length > 0,
    `no workflow files found under ${WORKFLOW_DIR} — this guard has gone stale`,
  );
});

test('every GitHub Actions workflow declares an explicit permissions block', () => {
  const files = fs.readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f));

  // 주석 안의 `permissions:` 가 통과시키면 안 된다. top-level(들여쓰기 없음) 또는
  // job-level(들여쓰기 있음) 어느 쪽이든 실제 선언이면 인정한다.
  const missing = files.filter((f) => {
    const yaml = stripYamlComments(fs.readFileSync(path.join(WORKFLOW_DIR, f), 'utf8'));
    return !/^\s*permissions:\s*$/m.test(yaml);
  });

  assert.deepEqual(
    missing,
    [],
    'these workflows declare no `permissions:` block, so their GITHUB_TOKEN silently inherits the ' +
      'repository default (write-capable on many repos) while running untrusted dependency install ' +
      `scripts and PR code — declare least privilege explicitly: ${missing.join(', ')}`,
  );
});

test('the CI workflow keeps its GITHUB_TOKEN read-only', () => {
  const yaml = stripYamlComments(fs.readFileSync(path.join(WORKFLOW_DIR, 'ci.yml'), 'utf8'));

  assert.match(
    yaml,
    /^permissions:\n\s+contents:\s*read\s*$/m,
    'ci.yml must pin `permissions: contents: read` at the top level — it runs `npm ci` (third-party ' +
      'install scripts) and full test suites from PR branches, so its token must not be able to write',
  );

  // read 로 고정한 의미가 사라지므로 어떤 스코프도 write 여선 안 된다.
  const writeScopes = yaml
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[a-z-]+:\s*write$/.test(l));
  assert.deepEqual(
    writeScopes,
    [],
    `ci.yml grants write scopes (${writeScopes.join(', ')}); no job in it writes anything — ` +
      'if a job genuinely needs write, scope it to that job rather than the whole workflow',
  );

  // 쓰기 권한이 필요해지는 유일한 이유는 secrets 사용인데, 이 워크플로는 쓰지 않는다.
  assert.ok(
    !/secrets\./.test(yaml),
    'ci.yml now references a secret — re-evaluate this read-only guard, since a workflow that ' +
      'handles secrets on `pull_request` is exposed to PR-authored code',
  );
});

// npm 은 provenance 발급 전에 package.json 의 repository URL 이 실제 빌드 중인
// 저장소와 일치하는지 확인한다. 불일치하면 publish 가 깨진다.
test('agent-manager package.json declares the repository provenance verifies against', () => {
  const pkg = JSON.parse(fs.readFileSync(AGENT_MANAGER_PKG, 'utf8'));
  const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  assert.ok(
    typeof url === 'string' && url.includes('github.com/parnmanas/ai-workflow-board'),
    'apps/agent-manager/package.json must carry a `repository` field pointing at this repo — ' +
      `npm refuses to generate provenance when it disagrees with the build repo (got: ${url})`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. 발행 표면 최소화 — 발행 대상이 아닌 워크스페이스는 발행될 수 없어야 한다
//    (2026-08-15 감사 추가)
// ─────────────────────────────────────────────────────────────────────────────

// 루트는 `private: true` 지만 `server` / `client` 워크스페이스는 아무 표시가
// 없었다. `npm publish --workspaces` 한 번이면(또는 워크스페이스 안에서 무심코
// 친 `npm publish` 한 번이면) 발행 의도가 없는 두 패키지가 공개 레지스트리로
// 나간다 — 둘 다 `files` 필드도 없어 tarball 은 디렉터리 전체가 된다.
// `private: true` 는 npm 이 publish 를 하드 거부하게 만드는 유일한 in-repo 통제라,
// 발행 가능한 이름을 의도한 하나(awb-agent-manager)로 고정한다.
test('only the intended workspace is publishable', () => {
  const publishable = [];
  for (const rel of ['apps/server', 'apps/client', 'apps/agent-manager']) {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel, 'package.json'), 'utf8'));
    if (pkg.private !== true) publishable.push(`${rel} (${pkg.name})`);
  }
  assert.deepEqual(
    publishable,
    ['apps/agent-manager (awb-agent-manager)'],
    'exactly one workspace may be publishable; mark every other workspace `"private": true` ' +
      `so npm refuses to publish it (currently publishable: ${publishable.join(', ') || 'none'})`,
  );

  const root = JSON.parse(fs.readFileSync(ROOT_PKG, 'utf8'));
  assert.equal(root.private, true, 'the monorepo root must stay `"private": true`');
});

// 발행되는 유일한 패키지는 tarball 내용물을 명시적으로 좁혀야 한다. `files` 가
// 없으면 npm 은 gitignore 되지 않은 모든 것을 담는다 — 테스트 픽스처, 로컬
// 스크립트, 미래에 추가될 무엇이든. `["dist"]` 는 publish 워크플로의 산출물
// 검증 단계(dist/package.json + dist/main.js)가 전제하는 값이기도 하다.
test('the published package narrows its tarball with an explicit `files` allowlist', () => {
  const pkg = JSON.parse(fs.readFileSync(AGENT_MANAGER_PKG, 'utf8'));
  assert.ok(
    Array.isArray(pkg.files) && pkg.files.length > 0,
    'apps/agent-manager/package.json must declare `files` — without it the tarball is the whole directory',
  );
  assert.deepEqual(pkg.files, ['dist'], 'the agent-manager tarball is meant to be dist/ only');
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. 설치(소비) 측 provenance 검증 — 발행 측 증명이 실제로 쓰이는지
//    (2026-08-15 감사 추가)
// ─────────────────────────────────────────────────────────────────────────────

// 위 4번이 "우리 tarball 에 SLSA 증명을 붙인다"를 보장한다. 그런데 매니저의
// npm-global self-update 는 그 증명을 확인하지 않고 `npm i -g …@latest` 를 그대로
// 실행하고 있었다 — 증명을 만들어만 놓고 아무도 읽지 않으면 NPM_TOKEN 유출
// 시나리오는 그대로 열려 있다. 상세 단위 테스트는
// apps/agent-manager/test/self-update-provenance-gate.test.mjs 에 있고,
// 여기서는 발행 측 가드 바로 옆에서 "소비 측 배선이 살아 있는지"만 확인한다.
test('the manager self-update consumes that provenance instead of installing blind', () => {
  const src = fs.readFileSync(
    path.join(REPO_ROOT, 'apps', 'agent-manager', 'src', 'lib', 'self-update.ts'),
    'utf8',
  );
  assert.match(
    src,
    /await verifyNpmGlobalProvenance\(out, channel\)/,
    'the npm-global self-update path must verify published provenance before installing, ' +
      'for the ACTIVE update channel (verifying @latest while installing @next would be a hole)',
  );
  assert.match(
    src,
    /npm-global update refused:/,
    'an unverified provenance verdict must abort the self-update (fail-closed), not just warn',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. 매니저 self-update 는 npm 단일 채널이어야 한다 (git 배포 경로 제거)
// ─────────────────────────────────────────────────────────────────────────────

// 이전에는 self-update 에 git 체크아웃 경로가 하나 더 있었다: `git fetch` →
// detached checkout → `npm ci` → build → re-exec. 그 경로는 provenance 게이트를
// 타지 않으므로(서명된 tarball 이 아니라 브랜치 tip 을 그대로 실행) "감사한 트리
// == 실행되는 트리" 명제에 구멍이었고, 방어 수단이 lockfile 강제뿐이었다.
// 지금은 경로 자체가 제거돼 npm(provenance 게이트 통과) 만 남았다. 이 가드는 그
// 두 번째 배포 채널이 조용히 되살아나지 않는지 본다 — 되살아나면 게이트를 우회하는
// 설치 경로가 다시 생기는 것이므로 공급망 관점에서는 회귀다.
test('the manager self-update has exactly one distribution channel (npm, no git path)', () => {
  const src = fs.readFileSync(
    path.join(REPO_ROOT, 'apps', 'agent-manager', 'src', 'lib', 'self-update.ts'),
    'utf8',
  );

  // 실제 spawn 인자만 본다 — 주석은 제거된 git 경로를 설명 목적으로 계속 언급한다.
  assert.ok(
    !/runAsync\(\s*'git'|runSync\(\s*'git'|spawn\(\s*'git'/.test(src),
    'self-update must not spawn git — that reintroduces a distribution channel ' +
      'that bypasses the npm provenance gate',
  );

  // 로컬 의존성 설치(`npm install` / `npm ci`)는 git 체크아웃을 빌드할 때만 필요했다.
  // 그 경로가 없으므로 남아 있으면 안 된다. (`npm install -g` 은 provenance 게이트를
  // 통과한 별개의 전역 설치 경로다.)
  assert.ok(
    !/\[\s*'install'\s*\]/.test(src) && !/\[\s*'ci'\s*\]/.test(src),
    'self-update must not run a local dependency install — it installs the published, ' +
      'provenance-verified package instead of building a tree from source',
  );

  // 가드가 죽은 채 초록불만 내는 것 방지 — 전역 설치 자체는 여전히 있어야 한다.
  assert.match(
    src,
    /\[\s*'install',\s*'-g',\s*installSpec\s*\]/,
    'the npm-global install must still be wired, pinned to the verified installSpec',
  );
});
