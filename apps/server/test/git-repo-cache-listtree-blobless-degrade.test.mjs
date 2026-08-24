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
// fillBlobSizesLocalOnly() 가 `git cat-file --batch-check --batch-all-objects`
// (로컬 pack/loose 객체 DB 스캔 — 네트워크를 전혀 건드리지 않음)로 채운다.
// 이미 로컬에 있는 blob 만 크기가 채워지고, 아직 fetch 되지 않은 blob 은
// `size: null` 로 degrade 한다(추가 fetch 하지 않음) — UI 는 이미
// `size != null` 가드로 이를 자연스럽게 처리한다.
//
// 왜 "그냥 batch-check 에 이 디렉터리 blob SHA 목록을 다 먹여서 noLazyFetch
// 로 감싸면 안 되는가"(직접 실측으로 확인한 이유, 아래 두 네거티브
// 컨트롤이 증명한다):
//  1. promisor 클론에서 batch-check 입력 중 단 하나라도 로컬에 없으면,
//     그 한 줄만 "missing" 으로 보고하고 계속하는 게 아니라 전체 프로세스가
//     `fatal: could not fetch <oid> from promisor remote` 로 즉시 죽는다
//     (exit 128) — 부분 성공이 불가능하다.
//  2. noLazyFetch 없이 여러 개를 한 번에 먹이면, git 은 그걸 한 번에
//     묶어서 fetch 하지 않고 missing 객체 하나당 별도의 promisor 협상을
//     연다 — `--long` 과 동일한 O(blob) 병리.
// 그래서 이 수정은 "요청한 특정 SHA 목록"이 아니라 "로컬에 이미 있는 전체
// 객체 목록"(`--batch-all-objects`)을 열거해 교집합을 취하는 방식을 쓴다.
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
let manySha; // src/many/file0.ts 의 blob sha — "이미 미리보기해서 로컬에 캐시된 파일" 시나리오용

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

  it('네거티브 컨트롤 B — cat-file --batch-check에 missing OID를 하나라도 섞으면 노이즈 없이 전체가 fatal(exit≠0)한다 (부분 성공 불가 — batch-all-objects 교집합 방식을 쓰는 이유)', () => {
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
});
