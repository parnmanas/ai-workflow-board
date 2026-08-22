// 회귀 테스트 — ticket e14ef1c9
// "[Ontology Graph 2/7] 추출 워커 — tree-sitter WASM Tier 1 + NestJS
// 리플렉션 룰셋" — 리뷰 라운드 2 필수 지적: OntologyExtractionService.
// extractRepo()가 runExtractionPool()의 파일별 실패(bundle=null,
// error!=null)를 filter((r) => r.bundle)로 조용히 버리고, 반환값에도
// 실패 파일 수/경로/원인이 없었다. pool.ts는 워커 비정상 exit를 파일별
// 에러 값으로 "의도적으로" 복구해 풀 전체 Promise를 정상 resolve시키므로
// (그 복구 자체는 ontology-extraction-pool-exit-handling.test.mjs가 이미
// 검증), 이 소비 경로(extractRepo())를 직접 통하지 않으면 소실 자체를
// 못 잡는다 — "단순 pool 단위 테스트만으로는 현재 소실을 잡지 못합니다"라는
// 리뷰 지적 그대로, extractRepo() 자신을 호출해 검증한다.
//
// git-repo-cache/실제 워커 풀/DB 없이 검증하기 위해
// OntologyExtractionService의 (테스트 전용) 재할당 가능 필드들
// (ensureRepoCache/listTree/getFileContent/listCommits/resolveGitCredential/
// runExtractionPool/persistFactBundles)을 전부 페이크로 교체한다 —
// 프로덕션 경로는 이 필드들을 절대 재할당하지 않는다
// (ontology-extraction.service.ts 클래스 헤더 코멘트).
//
// 컴파일된 dist/ 대상으로 실행한다(`npm run build` 필요) — 1/7과 같은 관례.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', 'dist');

const { OntologyExtractionService } = await import(
  'file://' + path.join(DIST_ROOT, 'modules/ontology/ontology-extraction.service.js')
);

function fakeResourceRepo() {
  return {
    async findOne() {
      return {
        id: 'res-1',
        workspace_id: 'ws-1',
        board_id: null,
        credential_id: null,
        name: 'fake-repo',
        description: '',
        type: 'repository',
        url: 'https://example.invalid/fake-repo.git',
        default_branch: 'main',
        content: '',
        file_data: '',
        file_name: '',
        file_mimetype: '',
        tags: '',
        created_at: new Date(0),
        updated_at: new Date(0),
      };
    },
  };
}

function makeBundle(filePath) {
  return {
    path: filePath,
    lang: 'typescript',
    defs: [],
    refs: [],
    imports: [],
    exports: [],
    heritage: [],
    docstrings: [],
    fileHash: 'deadbeef',
    extractorVersion: '1.0.0',
    hasParseError: false,
    skippedReason: null,
  };
}

function defaultPersistImpl() {
  return async (_dataSource, input) => ({
    filesProcessed: input.bundles.length,
    nodesInserted: input.bundles.length,
    edgesInserted: 0,
    containsEdges: 0,
    declaresEdges: 0,
    decoratesEdges: 0,
    decoratesUnresolved: 0,
    parseErrorFiles: 0,
    skippedFiles: 0,
    durationMs: 1,
  });
}

// 실제 git-repo-cache/워커 풀/DB를 전혀 건드리지 않는다 — extractRepo()
// 자신의 "풀 결과 -> 반환값" 조합 로직만 격리해서 검증하려는 것이 이
// 테스트의 목적이라, 그 앞뒤 단계(repo fetch, tree walk, 실제 파싱, 실제
// insert)는 전부 결정론적 페이크로 대체한다.
function buildService({ poolResults, persistImpl }) {
  const svc = new OntologyExtractionService(fakeResourceRepo(), {}, {});
  svc.resolveGitCredential = async () => null;
  svc.ensureRepoCache = async () => '/fake/repo/path';
  svc.listCommits = async () => [{ sha: 'c0ffee' }];
  svc.listTree = async (_repoPath, _ref, dir) => {
    if (dir !== '') return [];
    return [
      { name: 'a.ts', path: 'a.ts', type: 'blob', sha: 'x', size: 20 },
      { name: 'b.ts', path: 'b.ts', type: 'blob', sha: 'y', size: 20 },
    ];
  };
  svc.getFileContent = async (_repoPath, _ref, filePath) => ({
    path: filePath,
    size: 20,
    binary: false,
    too_large: false,
    truncated: false,
    content: 'export const x = 1;\n',
  });
  svc.runExtractionPool = async (tasks) => poolResults(tasks);
  svc.persistFactBundles = persistImpl ?? defaultPersistImpl();
  return svc;
}

describe('OntologyExtractionService.extractRepo() 워커 실패 전파 (ticket e14ef1c9, 리뷰 라운드 2)', () => {
  it('풀에서 실패(bundle=null, error!=null)로 돌아온 파일이 filesFailedExtraction/extractionFailures로 반환값에 보존되고, persist 입력에서는 제외된다', async () => {
    let persistInputBundlePaths = null;
    const svc = buildService({
      poolResults: (tasks) =>
        tasks.map((t) =>
          t.path === 'a.ts'
            ? { path: t.path, bundle: makeBundle(t.path), decoratorFacts: [], error: null }
            : {
                path: t.path,
                bundle: null,
                decoratorFacts: [],
                error: 'worker exited unexpectedly (code 1) with no message or error event',
              },
        ),
      persistImpl: async (_dataSource, input) => {
        persistInputBundlePaths = input.bundles.map((b) => b.path);
        return defaultPersistImpl()(_dataSource, input);
      },
    });

    const result = await svc.extractRepo({ workspaceId: 'ws-1', resourceId: 'res-1', folderPath: '', graphId: 'graph-1' });

    assert.equal(result.filesDiscovered, 2, '두 파일 다 발견은 됐다');
    assert.equal(result.filesFailedExtraction, 1, '워커 실패 1건이 카운트에 반영돼야 한다');
    assert.equal(result.extractionFailures.length, 1);
    assert.equal(result.extractionFailures[0].path, 'b.ts');
    assert.match(result.extractionFailures[0].error, /worker exited unexpectedly/);
    // 실패한 파일이 그래프에 섞여 들어가지 않아야 한다 — persist에는 성공한
    // 파일만 넘어간다.
    assert.deepEqual(persistInputBundlePaths, ['a.ts']);
    assert.equal(result.filesProcessed, 1);
  });

  it('워커 실패가 전혀 없으면 filesFailedExtraction=0, extractionFailures=[]다(정상 경로 회귀 없음)', async () => {
    const svc = buildService({
      poolResults: (tasks) => tasks.map((t) => ({ path: t.path, bundle: makeBundle(t.path), decoratorFacts: [], error: null })),
    });

    const result = await svc.extractRepo({ workspaceId: 'ws-1', resourceId: 'res-1', folderPath: '', graphId: 'graph-1' });

    assert.equal(result.filesFailedExtraction, 0);
    assert.deepEqual(result.extractionFailures, []);
    assert.equal(result.filesProcessed, 2);
  });

  it('워커 에러 메시지가 300자를 넘으면 절단(redact)된다', async () => {
    const longError = 'x'.repeat(500);
    const svc = buildService({
      poolResults: (tasks) => tasks.map((t) => ({ path: t.path, bundle: null, decoratorFacts: [], error: longError })),
    });

    const result = await svc.extractRepo({ workspaceId: 'ws-1', resourceId: 'res-1', folderPath: '', graphId: 'graph-1' });

    assert.equal(result.filesFailedExtraction, 2);
    assert.equal(result.extractionFailures.length, 2);
    for (const f of result.extractionFailures) {
      assert.ok(f.error.length <= 301, `절단된 에러는 301자(300 + 말줄임표) 이하여야 한다, 실제 ${f.error.length}`);
      assert.ok(f.error.endsWith('…'));
    }
  });
});
