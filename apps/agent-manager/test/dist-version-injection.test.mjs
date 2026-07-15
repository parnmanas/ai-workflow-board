// 버전 주입 wire 계약 검증 (ticket 433f6cbd, board lesson #1: 가상 payload 가 아니라
// 실제 산출물 경로를 end-to-end 로 검증한다).
//
// 불변식(npm-global self-update 가 수렴하려면 반드시 성립):
//   npm 에 publish 되는 버전  ==  tarball 의 dist/package.json version
//                            ==  readBundledVersion()  ==  UpdateChecker.current_version
//
// CI(publish-agent-manager.yml)는 계산된 버전을 **build 직전** package.json 에 적고,
// build 스크립트가 그걸 dist/package.json 으로 복사한다. 그래서 여기서 검증할 고리는:
//   package.json.version  --(build copy)-->  dist/package.json.version
//                         --(readBundledVersion)-->  current_version
// 이 고리가 끊기면(예: build 가 복사를 안 함, readBundledVersion 이 엉뚱한 파일을
// 읽음) publish 버전과 tarball 버전이 어긋나 매니저가 "항상 업데이트 필요" 무한
// 루프에 빠진다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = join(HERE, '..'); // apps/agent-manager
const pkgJson = () => JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'));

// dist/ 산출물을 임포트 — `npm test` 가 build 를 먼저 돌리므로 존재한다.
const { readBundledVersion, UpdateChecker } = await import('../dist/lib/self-update.js');

test('build 스크립트가 package.json 을 dist/package.json 으로 복사한다 (구조)', () => {
  const build = pkgJson().scripts?.build || '';
  assert.match(
    build,
    /copyFileSync\(\s*['"]package\.json['"]\s*,\s*['"]dist\/package\.json['"]\s*\)/,
    'build 가 package.json → dist/package.json 복사를 포함해야 버전이 tarball 로 전달된다',
  );
});

test('build 의 copy 명령이 임의 버전을 실제로 전파한다 (격리 fixture, 실명령 재현)', () => {
  // build 스크립트의 정확한 copy 명령을 격리 디렉터리에서 그대로 실행해, "package.json
  // 에 버전 X 를 적고 빌드하면 dist/package.json.version 이 X 가 된다"를 증명한다.
  const dir = mkdtempSync(join(tmpdir(), 'awb-dist-inject-'));
  try {
    const SENTINEL = '9.9.9-sentinel';
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: SENTINEL }) + '\n');
    mkdirSync(join(dir, 'dist'), { recursive: true });
    // 실제 build 스크립트와 동일한 명령.
    execFileSync(
      process.execPath,
      ['-e', "require('fs').copyFileSync('package.json','dist/package.json')"],
      { cwd: dir },
    );
    const dist = JSON.parse(readFileSync(join(dir, 'dist', 'package.json'), 'utf8'));
    assert.equal(dist.version, SENTINEL, 'CI 가 stamp 한 버전이 dist/package.json 으로 전파돼야 한다');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('빌드된 dist/package.json 이 실제로 존재하고 version 을 갖는다', () => {
  const distPkgPath = join(PKG_DIR, 'dist', 'package.json');
  assert.ok(existsSync(distPkgPath), 'dist/package.json 이 build 로 생성돼야 한다');
  const distPkg = JSON.parse(readFileSync(distPkgPath, 'utf8'));
  assert.match(distPkg.version, /^\d+\.\d+\.\d+/, 'dist/package.json.version 이 semver 여야 한다');
});

test('readBundledVersion() == dist/package.json.version (tarball 버전 = 리포트 버전)', () => {
  const distPkg = JSON.parse(readFileSync(join(PKG_DIR, 'dist', 'package.json'), 'utf8'));
  assert.equal(
    readBundledVersion(),
    distPkg.version,
    'readBundledVersion 은 dist/package.json 을 읽어 tarball 버전을 리포트해야 한다',
  );
});

test('build 후 dist/package.json.version == package.json.version (동기화 유지)', () => {
  const distPkg = JSON.parse(readFileSync(join(PKG_DIR, 'dist', 'package.json'), 'utf8'));
  assert.equal(
    distPkg.version,
    pkgJson().version,
    'build 가 package.json 을 그대로 복사하므로 두 값이 같아야 한다',
  );
});

test('UpdateChecker.current_version == readBundledVersion() (heartbeat 가 리포트하는 버전)', () => {
  // 타이머는 start() 하지 않는다 — 생성자만으로 current_version 이 정해진다.
  const status = new UpdateChecker().status();
  assert.equal(
    status.current_version,
    readBundledVersion(),
    'heartbeat 의 current_version 은 bundled(dist) 버전과 일치해야 self-update 가 수렴한다',
  );
});
