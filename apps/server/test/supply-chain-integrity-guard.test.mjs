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
