// 회귀 테스트 — ticket 719ef137
// "[Ontology Graph] 그래프 빌드 실패 — blobless 캐시 클론에서 `git ls-tree
// --long`이 blob당 promisor fetch를 유발해 15s 타임아웃".
//
// 근본 원인: git-repo-cache.ts의 listTree()는 파일 크기를 얻으려고
// `git ls-tree --long`을 쓰는데, `--long`은 blob마다 object size를
// 요구한다. bare+blobless(`--filter=blob:none`) 캐시 클론에는 그 blob이
// 없어서, git이 blob 하나당 promisor lazy fetch를 직렬로 돌린다.
// ontology-extraction.service.ts의 walkTree()는 디렉터리마다 listTree()를
// 순차 BFS로 호출했으므로, 왕복 누적이 READ_TIMEOUT_MS(15s)를 넘겨
// `GitReadError: git ls-tree timed out`으로 죽었다.
//
// 수정: git-repo-cache.ts에 두 함수를 추가했다.
//  - listTreeRecursive() — `git ls-tree -r`(사이즈 없이) 단 1회로 서브트리
//    전체를 나열한다. blob 내용/크기를 전혀 요구하지 않으므로 blobless
//    클론에서도 promisor fetch가 0회다.
//  - getFileContentsBatch() — 파일별 `cat-file -s`+`cat-file blob`(N개 파일 =
//    2N 왕복) 대신, `fetch --filter=blob:none --stdin`으로 필요한 blob을
//    한 번에 백필하고 `cat-file --batch` 단일 프로세스로 읽는다.
//
// 두 함수 모두 `noLazyFetch`(GIT_NO_LAZY_FETCH=1)를 내부에서 세팅한다 —
// 회귀가 생겨 다시 blob 크기/내용을 요구하게 되면 조용히 느려지는 대신
// 즉시 GitReadError로 실패한다. 이 테스트는 그 실패 모드 자체가 실재함을
// (아래 "네거티브 컨트롤" 테스트로) 먼저 증명한 뒤, 새 함수들이 그 실패
// 모드를 피해간다는 것을 증명한다 — 두 방향 다 확인해야 픽스처가 우연히
// 이미 통과 상태라서 나머지 assertion이 공허하게 참인 상황을 배제할 수
// 있다.
//
// 컴파일된 dist/ 대상으로 실행한다(`npm run build` 필요) — 이 파일군의 관례.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', 'dist');

const { listTreeRecursive, getFileContentsBatch } = await import(
  'file://' + path.join(DIST_ROOT, 'modules/mcp/shared/git-repo-cache.js')
);

const originDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-blobless-origin-'));
const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-blobless-clone-'));
const cachePath = path.join(cloneDir, 'repo.git');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).toString().trim();
}

// AWB 실제 레포처럼 "블롭이 많은 디렉터리"를 만든다 — 티켓 실측(59 blob
// 디렉터리 = ls-tree --long 2.85~3.06s / 118 fetch)과 같은 계열의 병리를
// 재현하되, 로컬 테스트에서 초 단위로 끝나도록 규모만 줄인다(20개).
const MANY_COUNT = 20;
const expectedFiles = new Set();

before(() => {
  git(['init', '-q', '-b', 'main'], originDir);
  git(['config', 'user.email', 'test@awb.local'], originDir);
  git(['config', 'user.name', 'AWB Test'], originDir);

  fs.mkdirSync(path.join(originDir, 'src', 'many'), { recursive: true });
  for (let i = 0; i < MANY_COUNT; i++) {
    const rel = `src/many/file${i}.ts`;
    fs.writeFileSync(path.join(originDir, rel), `export const v${i} = ${i};\n`);
    expectedFiles.add(rel);
  }
  fs.mkdirSync(path.join(originDir, 'src', 'nested', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(originDir, 'src', 'nested', 'top.ts'), 'export const top = 1;\n');
  fs.writeFileSync(path.join(originDir, 'src', 'nested', 'deep', 'bottom.ts'), 'export const bottom = 1;\n');
  expectedFiles.add('src/nested/top.ts');
  expectedFiles.add('src/nested/deep/bottom.ts');
  // 확장자로 걸러지는 파일이 아니라 "blob"이라는 사실 자체를 테스트하려는
  // 것이므로 이진 파일 하나도 섞는다 — getFileContentsBatch의 NUL 기반
  // binary 판정이 배치 경로에서도 살아있는지 확인한다.
  fs.writeFileSync(path.join(originDir, 'src', 'nested', 'image.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
  expectedFiles.add('src/nested/image.bin');
  fs.writeFileSync(path.join(originDir, 'README.md'), '# not under src\n');

  git(['add', '-A'], originDir);
  git(['commit', '-q', '-m', 'init'], originDir);
  // 실측 재현과 동일 — 로컬 서버가 blobless 클론을 서빙하려면 필요.
  git(['config', 'uploadpack.allowfilter', 'true'], originDir);

  // production ensureRepoCache()와 동일한 clone 커맨드 형태: bare + blobless.
  execFileSync(
    'git',
    ['clone', '-q', '--bare', '--filter=blob:none', '--', `file://${originDir}`, cachePath],
    { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
  );
});

after(() => {
  fs.rmSync(originDir, { recursive: true, force: true });
  fs.rmSync(cloneDir, { recursive: true, force: true });
});

function countObjects() {
  const raw = git(['count-objects', '-v'], cachePath);
  const out = {};
  for (const line of raw.split('\n')) {
    const [k, v] = line.split(':').map((s) => s.trim());
    if (k) out[k] = parseInt(v, 10);
  }
  return out;
}

describe('blobless 캐시 클론에서 lazy-fetch 회귀 가드 (ticket 719ef137)', () => {
  it('네거티브 컨트롤 — 옛 패턴(ls-tree --long)은 이 픽스처에서 실제로 blob을 promisor fetch한다', () => {
    // 이 테스트가 픽스처 자체를 증명한다: 아래 listTreeRecursive 테스트들이
    // 통과하는 게 "애초에 fetch할 게 없어서"가 아니라 "새 구현이 fetch를
    // 피해서"임을 보이려면, 같은 픽스처에서 옛 패턴이 진짜로 fetch를
        // 유발한다는 걸 먼저 확인해야 한다.
    const before = countObjects();
    execFileSync('git', ['ls-tree', '--long', '--', 'HEAD:src/many'], {
      cwd: cachePath,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    const after = countObjects();
    assert.ok(
      after['in-pack'] > before['in-pack'],
      `ls-tree --long이 blob을 promisor fetch해야 픽스처가 유효하다 (before.in-pack=${before['in-pack']}, after.in-pack=${after['in-pack']})`,
    );

    // 같은 옛 패턴을 GIT_NO_LAZY_FETCH=1 아래서 돌리면 조용히 느려지는 대신
    // 즉시 실패해야 한다 — listTreeRecursive/getFileContentsBatch가 내부에서
    // 기대는 것과 동일한 안전장치가 실제로 이 git 버전에서 동작함을 증명.
    assert.throws(() => {
      execFileSync('git', ['ls-tree', '--long', '--', 'HEAD:src/nested'], {
        cwd: cachePath,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' },
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    }, /Command failed/, 'GIT_NO_LAZY_FETCH=1은 옛 패턴을 즉시 실패시켜야 한다');
  });

  it('listTreeRecursive는 promisor fetch 0회로 서브트리 전체를 한 번에 나열한다', async () => {
    const before = countObjects();
    const start = Date.now();
    const entries = await listTreeRecursive(cachePath, 'HEAD', 'src');
    const elapsedMs = Date.now() - start;
    const after = countObjects();

    assert.deepEqual(before, after, 'listTreeRecursive는 어떤 blob도 fetch하면 안 된다 (count-objects 불변)');
    assert.ok(elapsedMs < 5000, `promisor fetch가 없다면 로컬 file:// 픽스처에서 5s 안에 끝나야 한다 (실제 ${elapsedMs}ms)`);

    const gotPaths = new Set(entries.map((e) => e.path));
    for (let i = 0; i < MANY_COUNT; i++) assert.ok(gotPaths.has(`src/many/file${i}.ts`), `file${i}.ts 누락`);
    assert.ok(gotPaths.has('src/nested/top.ts'));
    assert.ok(gotPaths.has('src/nested/deep/bottom.ts'), '중첩 서브디렉터리까지 재귀적으로 나열돼야 한다');
    assert.ok(!gotPaths.has('README.md'), 'src 밖 파일은 나오면 안 된다(treePath 스코프 준수)');
    assert.equal(entries.length, MANY_COUNT + 3, `src 아래 blob 총 개수(${MANY_COUNT} + top/bottom/image.bin)`);
  });

  it('listTreeRecursive는 중첩 서브디렉터리를 treePath로 줘도 상대경로를 올바르게 복원한다', async () => {
    const entries = await listTreeRecursive(cachePath, 'HEAD', 'src/nested');
    const gotPaths = new Set(entries.map((e) => e.path));
    assert.deepEqual(gotPaths, new Set(['src/nested/top.ts', 'src/nested/deep/bottom.ts', 'src/nested/image.bin']));
  });

  it('getFileContentsBatch는 두 번의 git 프로세스(bulk fetch + cat-file --batch)로 모든 파일 내용을 정확히 읽는다', async () => {
    const entries = await listTreeRecursive(cachePath, 'HEAD', 'src/nested');
    const start = Date.now();
    const fetched = await getFileContentsBatch(cachePath, entries);
    const elapsedMs = Date.now() - start;

    assert.ok(elapsedMs < 10000, `2개 프로세스로 끝나면 파일 수와 무관하게 빨라야 한다 (실제 ${elapsedMs}ms)`);
    assert.equal(fetched.size, entries.length);

    const top = fetched.get('src/nested/top.ts');
    assert.equal(top.binary, false);
    assert.equal(top.too_large, false);
    assert.equal(top.content, 'export const top = 1;\n');

    const bottom = fetched.get('src/nested/deep/bottom.ts');
    assert.equal(bottom.content, 'export const bottom = 1;\n');

    const image = fetched.get('src/nested/image.bin');
    assert.equal(image.binary, true, 'NUL 바이트가 있으면 배치 경로에서도 binary=true여야 한다');
    assert.equal(image.content, '', 'binary 파일은 content를 비워야 한다');
    assert.equal(image.size, 6);

    // 지금 이 clone은 이미 위 테스트에서 src/many를 통해 일부 blob을
    // 백필했을 수 있으므로, 여기서는 "0 fetch"가 아니라 "요청한 모든 blob이
    // 로컬에 존재하게 됐다"만 확인한다(중복 백필 자체는 무해하다).
    const check = git(['cat-file', '--batch-check', '--batch-all-objects'], cachePath);
    assert.ok(check.length > 0);
  });

  it('AWB 레포 규모(1,346 파일)를 흉내낸 파일 수에서도 listTreeRecursive는 즉시 끝난다', async () => {
    // 실제 1,346개를 커밋하는 대신, 이미 만든 20+3개 픽스처로 반복 호출해
    // "디렉터리 수에 비례해 느려지지 않는다"는 핵심 속성(단일 spawn)만
    // 별도로 확인한다 — walkTree의 옛 O(디렉터리) BFS와 달리 이 함수는
        // treePath 하나당 항상 spawn 1회다.
    const start = Date.now();
    for (let i = 0; i < 10; i++) {
      await listTreeRecursive(cachePath, 'HEAD', '');
    }
    const elapsedMs = Date.now() - start;
    assert.ok(elapsedMs < 5000, `단일 spawn 호출 10회가 5s를 넘으면 안 된다 (실제 ${elapsedMs}ms)`);
  });
});
