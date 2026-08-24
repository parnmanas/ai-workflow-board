// 회귀 테스트 — ticket 4796899d
// "[Ontology Graph] UI 파일 브라우저 listTree() 도 blobless 클론에서 blob당
// promisor fetch — 사용자 체감 지연".
//
// 근본 원인(719ef137 과 동일 계열): git-repo-cache.ts 의 listTree() 는 파일
// 크기를 얻으려고 `git ls-tree --long` 을 쓰는데, `--long` 은 blob 마다
// object size 를 요구한다. bare+blobless(`--filter=blob:none`) 캐시
// 클론에는 그 blob 이 없어서, git 이 blob 하나당 promisor lazy fetch 를
// 직렬로 돌린다. listTree() 는 UI 파일 브라우저(resources.controller.ts
// GET :id/tree)가 디렉터리를 열 때마다 호출하므로, 파일 많은 디렉터리를
// 열 때마다 사용자가 지연을 체감한다.
//
// 수정: git-repo-cache.ts 의 listTree() 에서 `--long` 을 제거했다(plain
// `ls-tree` 는 tree 객체만 읽으므로 blobless 클론에서도 항상 로컬에 있고,
// 따라서 어떤 lazy fetch 도 유발하지 않는다). 크기는 별도로
// fillBlobSizesLocalOnly() 가 이 디렉터리의 blob 하나당 독립적인 `git
// cat-file --batch-check`(noLazyFetch, 동시 실행 상한
// LOCAL_SIZE_LOOKUP_CONCURRENCY=16)를 띄워 채운다 — 로컬에 있으면 즉시
// size, 없으면 그 호출 하나만 실패(다른 blob 조회에는 영향 없음). 이미
// 로컬에 있는 blob 만 크기가 채워지고, 아직 fetch 되지 않은 blob 은
// `size: null` 로 degrade 한다(추가 fetch 하지 않음) — UI 는 이미
// `size != null` 가드로 이를 자연스럽게 처리한다.
//
// 왜 "그냥 batch-check 에 이 디렉터리 blob SHA 목록을 다 먹여서 noLazyFetch
// 로 감싸면 안 되는가"(직접 실측으로 확인한 이유, 아래 네거티브 컨트롤
// B 가 증명한다): promisor 클론에서 batch-check 입력 중 단 하나라도
// 로컬에 없으면, 그 한 줄만 "missing" 으로 보고하고 계속하는 게 아니라
// 전체 프로세스가 `fatal: could not fetch <oid> from promisor remote`
// 로 즉시 죽는다(exit 128) — 부분 성공이 불가능하다.
//
// 리뷰 라운드 1 지적 및 재수정: 최초 구현은 "요청한 특정 SHA 목록" 대신
// `--batch-all-objects`(캐시 클론이 가진 전체 로컬 객체 열거)로 교집합을
// 취했는데, 그 비용이 이 디렉터리의 blob 수가 아니라 클론 전체의 로컬
// 객체 수에 비례해 오래/큰 저장소에서 디렉터리를 열 때마다 저장소 전체를
// 훑는 꼴이었다(이 티켓이 고치려던 문제를 다른 축에서 재현). 그래서
// blob 하나당 독립 호출로 바꿔 비용을 이 디렉터리의 blob 수에만 비례하게
// 했다 — 아래 "구현이 --batch-all-objects 를 쓰지 않는다" 그리고 "저장소
// 전체 로컬 객체가 많아도 작은 디렉터리는 그 규모와 무관하게 빠르다" 두
// 테스트로 이 재수정을 고정한다.
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

const { listTree } = await import(
  'file://' + path.join(DIST_ROOT, 'modules/mcp/shared/git-repo-cache.js')
);

const originDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-listtree-blobless-origin-'));
const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-listtree-blobless-clone-'));
const cachePath = path.join(cloneDir, 'repo.git');

function git(args, cwd, env) {
  return execFileSync('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env } }).toString().trim();
}

// 티켓 719ef137 실측(59 blob 디렉터리 = ls-tree --long 2.85~3.06s / 118
// fetch)과 같은 계열의 병리를 재현하되, 로컬 테스트에서 초 단위로 끝나도록
// 규모만 줄인다. AWB 실제 사례 문구("파일 40~60개짜리 디렉터리")에 맞춰
// 30개로 설정.
const MANY_COUNT = 30;
// "저장소 전체는 로컬 객체가 많지만 이번에 열 디렉터리는 작다"를 재현하는
// 별도 디렉터리 — src/many 나 src/nested 와는 무관하게, 오직 캐시 클론의
// 로컬 pack 객체 수를 부풀리는 용도로만 쓴다(이 디렉터리 자체를
// listTree()로 여는 테스트는 없음).
const HAYSTACK_COUNT = 200;
let manySha; // src/many/file0.ts 의 blob sha — "이미 미리보기해서 로컬에 캐시된 파일" 시나리오용
let haystackShas;

before(() => {
  git(['init', '-q', '-b', 'main'], originDir);
  git(['config', 'user.email', 'test@awb.local'], originDir);
  git(['config', 'user.name', 'AWB Test'], originDir);

  fs.mkdirSync(path.join(originDir, 'src', 'many'), { recursive: true });
  for (let i = 0; i < MANY_COUNT; i++) {
    fs.writeFileSync(path.join(originDir, 'src', 'many', `file${i}.ts`), `export const v${i} = ${i};\n`);
  }
  fs.mkdirSync(path.join(originDir, 'src', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(originDir, 'src', 'nested', 'top.ts'), 'export const top = 1;\n');
  fs.mkdirSync(path.join(originDir, 'src', 'many', 'deeper'), { recursive: true });
  fs.writeFileSync(path.join(originDir, 'src', 'many', 'deeper', 'bottom.ts'), 'export const bottom = 1;\n');
  fs.mkdirSync(path.join(originDir, 'src', 'haystack'), { recursive: true });
  for (let i = 0; i < HAYSTACK_COUNT; i++) {
    fs.writeFileSync(path.join(originDir, 'src', 'haystack', `h${i}.ts`), `export const h${i} = ${i};\n`);
  }
  // src/nested 는 네거티브 컨트롤 A(`ls-tree --long`)가 이미 blob을
  // fetch시켜 오염되므로, haystack 테스트에서는 어떤 이전 테스트도 손대지
  // 않는 이 디렉터리를 써서 "정말 캐시되지 않았다"를 깨끗하게 확인한다.
  fs.mkdirSync(path.join(originDir, 'src', 'isolated'), { recursive: true });
  fs.writeFileSync(path.join(originDir, 'src', 'isolated', 'only.ts'), 'export const isolated = 1;\n');

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

  manySha = git(['rev-parse', 'HEAD:src/many/file0.ts'], cachePath);
  haystackShas = git(['ls-tree', '-r', '--format=%(objectname)', 'HEAD:src/haystack'], cachePath).split('\n').filter(Boolean);
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

describe('UI 파일 브라우저 listTree() 의 blobless 클론 lazy-fetch 회귀 가드 (ticket 4796899d)', () => {
  it('네거티브 컨트롤 A — 옛 패턴(ls-tree --long)은 이 픽스처에서 실제로 blob을 promisor fetch한다', () => {
    const before = countObjects();
    execFileSync('git', ['ls-tree', '--long', '--', 'HEAD:src/nested'], {
      cwd: cachePath,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    const after = countObjects();
    assert.ok(
      after['in-pack'] > before['in-pack'],
      `ls-tree --long이 blob을 promisor fetch해야 픽스처가 유효하다 (before.in-pack=${before['in-pack']}, after.in-pack=${after['in-pack']})`,
    );
  });

  it('네거티브 컨트롤 B — cat-file --batch-check에 missing OID를 하나라도 섞으면 노이즈 없이 전체가 fatal(exit≠0)한다 (부분 성공 불가 — blob마다 독립 호출로 나누는 이유)', () => {
    assert.throws(() => {
      execFileSync('git', ['cat-file', '--batch-check'], {
        cwd: cachePath,
        input: `${manySha}\nffffffffffffffffffffffffffffffffffffffff\n`,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' },
        stdio: ['pipe', 'ignore', 'ignore'],
      });
    }, /Command failed/, 'missing OID가 섞인 batch-check는 GIT_NO_LAZY_FETCH=1 아래서 전체가 실패해야 한다');
  });

  it('listTree는 완전히 새 클론(아무 blob도 로컬에 없음)에서 promisor fetch 0회로 응답하고, 모든 파일 크기는 null로 degrade한다', async () => {
    const before = countObjects();
    const start = Date.now();
    const entries = await listTree(cachePath, 'HEAD', 'src/many');
    const elapsedMs = Date.now() - start;
    const after = countObjects();

    assert.deepEqual(before, after, 'listTree는 어떤 blob도 fetch하면 안 된다 (count-objects 불변)');
    assert.ok(elapsedMs < 5000, `promisor fetch가 없다면 로컬 file:// 픽스처에서 5s 안에 끝나야 한다 (실제 ${elapsedMs}ms)`);

    // dirs first, alphabetical — 'deeper'(tree)가 file0..file9 앞에 와야 함.
    assert.equal(entries[0].name, 'deeper');
    assert.equal(entries[0].type, 'tree');
    assert.equal(entries[0].size, null, 'tree는 항상 size null');

    const fileEntries = entries.filter((e) => e.type === 'blob');
    assert.equal(fileEntries.length, MANY_COUNT, '파일 개수가 모두 나열돼야 한다');
    for (const e of fileEntries) {
      assert.equal(e.size, null, `아직 로컬에 없는 blob(${e.name})은 size가 null로 degrade해야 한다 — 에러로 죽으면 안 된다`);
      assert.equal(e.path, `src/many/${e.name}`);
    }
  });

  it('listTree는 이미 로컬에 캐시된 blob은 정확한 size를 채우고, 나머지는 여전히 null로 남기며, 추가 fetch는 하지 않는다', async () => {
    // "사용자가 이 파일을 이미 미리보기해서 로컬에 캐시돼 있다"를 시뮬레이션
    // — getFileContent()가 하는 것과 동일하게 cat-file blob으로 해당 blob
    // 하나만 lazy-fetch 시켜둔다(이 fetch 자체는 이 테스트가 검증하려는
    // listTree() 호출 이전에 일어나므로 무관).
    git(['cat-file', 'blob', manySha], cachePath);

    const before = countObjects();
    const entries = await listTree(cachePath, 'HEAD', 'src/many');
    const after = countObjects();
    assert.deepEqual(before, after, 'listTree 자체는 이 호출에서 추가 fetch를 하면 안 된다');

    const file0 = entries.find((e) => e.name === 'file0.ts');
    assert.ok(file0, 'file0.ts가 목록에 있어야 한다');
    assert.equal(file0.size, 'export const v0 = 0;\n'.length, '이미 로컬에 있는 blob은 정확한 size를 채워야 한다');

    const file1 = entries.find((e) => e.name === 'file1.ts');
    assert.equal(file1.size, null, '캐시되지 않은 다른 blob은 여전히 size null이어야 한다(부분 성공 확인)');
  });

  it('listTree는 중첩 서브디렉터리를 treePath로 줘도 상대경로를 올바르게 복원한다', async () => {
    const entries = await listTree(cachePath, 'HEAD', 'src/nested');
    assert.deepEqual(entries.map((e) => e.path), ['src/nested/top.ts']);
    assert.equal(entries[0].type, 'blob');
  });

  it('구현이 --batch-all-objects 를 쓰지 않는다 (리뷰 라운드 1 지적 — 캐시 클론 전체 로컬 객체를 스캔하면 디렉터리 크기가 아니라 저장소 전체 크기에 비례하게 된다)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'mcp', 'shared', 'git-repo-cache.ts'), 'utf8');
    // JS 문자열 리터럴 형태(작은따옴표로 감싼)만 검사한다 — 이 파일의 실제
    // git argv 배열은 전부 `'...'` 로 인자를 감싸므로, 이 형태가 없으면
    // 코드에서 실제로 그 플래그를 쓰지 않는다는 뜻이다. 이 주석 자체나 이
    // 함수의 JSDoc처럼 백틱으로 플래그 이름을 "언급"만 하는 산문은 오탐하지
    // 않는다.
    assert.ok(
      !src.includes("'--batch-all-objects'"),
      'fillBlobSizesLocalOnly가 다시 --batch-all-objects로 캐시 클론 전체의 로컬 객체를 열거하면, 크기 조회 비용이 이 디렉터리의 blob 수가 아니라 저장소 전체 로컬 객체 수(오래/큰 저장소일수록 계속 커짐)에 비례하는 회귀다',
    );
  });

  it('저장소 전체의 로컬 객체(blob 200개)를 미리 캐시해도, 그와 무관한 작은 디렉터리의 listTree는 여전히 빠르게 응답하고 fetch를 하지 않는다 (비용이 저장소 전체가 아니라 요청 디렉터리 blob 수에만 비례함을 확인)', async () => {
    // src/haystack 전체를 한 번의 bulk fetch로 로컬에 캐시해 "로컬 객체가
    // 아주 많은, 오래/큰 저장소"를 흉내낸다 — 719ef137의
    // getFileContentsBatch()와 동일한 fetch --filter=blob:none --stdin
    // 패턴(단일 스폰으로 다수 blob 백필).
    execFileSync(
      'git',
      ['-c', 'fetch.negotiationAlgorithm=noop', 'fetch', 'origin', '--no-tags', '--no-write-fetch-head', '--filter=blob:none', '--stdin'],
      { cwd: cachePath, input: haystackShas.map((s) => `${s}\n`).join(''), env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    );

    const before = countObjects();
    assert.ok(before['in-pack'] >= HAYSTACK_COUNT, `haystack 백필이 실제로 로컬 객체 수를 부풀렸어야 한다 (in-pack=${before['in-pack']})`);

    const start = Date.now();
    // src/haystack 이 아니라, haystack 과 전혀 무관하고 어떤 이전 테스트도
    // 손대지 않은 작은 디렉터리(파일 1개)를 연다 — --batch-all-objects
    // 였다면 이 호출도 haystack 을 포함한 전체 로컬 객체를 훑었을 것이다.
    const entries = await listTree(cachePath, 'HEAD', 'src/isolated');
    const elapsedMs = Date.now() - start;
    const after = countObjects();

    assert.deepEqual(before, after, 'listTree는 haystack과 무관하게 이 호출에서 추가 fetch를 하면 안 된다');
    assert.ok(elapsedMs < 2000, `저장소 전체 로컬 객체가 ${before['in-pack']}개여도 파일 1개짜리 디렉터리는 2s 안에 끝나야 한다 (실제 ${elapsedMs}ms)`);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].size, null, 'src/isolated/only.ts는 haystack과 무관하게 캐시되지 않았으므로 여전히 null이어야 한다');
  });
});
