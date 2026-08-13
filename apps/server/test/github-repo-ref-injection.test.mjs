// github-connector.service.ts 회귀 테스트 — owner/repo가 검증 없이 REST 경로에
// 보간되던 GitHub API path injection을 막는다.
//
// 취약점: `fetch_github_info` MCP 도구는 owner/repo를 자유 문자열(z.string())로
// 받아 `${GITHUB_API}/repos/${owner}/${repo}` 에 그대로 끼워 넣었다. WHATWG URL
// 정규화가 `..` 세그먼트를 접어버리므로
//   owner="x", repo="../../user/repos?visibility=private&"
//     → https://api.github.com/user/repos?visibility=private&
// 처럼 요청이 /repos/... 밖의 임의 GitHub 엔드포인트로 재조준되었고, 그 요청은
// 서버가 보관한 GitHub 토큰(또는 호출자가 지정한 credential_id)을 그대로 달고
// 나갔다 — 호출자가 직접 쥘 수 없는 토큰으로 비공개 저장소 목록을 읽어낼 수 있다.
//
// 방어는 2겹이며 둘 다 여기서 검증한다.
//  1) assertRepoRef / isValidRepoRef — 진입점 charset 검증 (`?` 질의 주입 포함,
//     중앙 가드가 `?` 이후를 보지 않으므로 이 층이 반드시 필요하다)
//  2) assertGitHubApiUrl — 모든 요청 직전 마지막 방어선 (traversal + origin)
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', 'dist');

const {
  assertRepoRef,
  isValidRepoRef,
  assertGitHubApiUrl,
  parseGitHubUrl,
  GitHubInvalidRepoRefError,
} = await import('file://' + path.join(DIST_ROOT, 'services', 'github-connector.service.js'));

test('assertRepoRef — 정상 owner/repo는 그대로 통과한다', () => {
  for (const [owner, repo] of [
    ['parnmanas', 'ai-workflow-board'],
    ['a', 'b'],
    ['Org-123', 'repo.name_with-dots'],
  ]) {
    assert.deepEqual(assertRepoRef(owner, repo), { owner, repo });
  }
});

test('assertRepoRef — traversal / 질의 주입 / 구분자를 거부한다', () => {
  const rejected = [
    ['../..', 'user'],                                   // 원 익스플로잇: /user 로 재조준
    ['x', '../../user/repos?visibility=private&'],       // 비공개 저장소 열람
    ['x', 'y?foo=bar'],                                  // 질의 주입 (중앙 가드로는 못 잡음)
    ['x', 'y#frag'],                                     // fragment 주입
    ['x', 'y/z'],                                        // 경로 세그먼트 탈출
    ['.', 'x'], ['..', '..'], ['x', '.'], ['x', '..'],   // 순수 traversal 세그먼트
    ['x y', 'z'],                                        // 공백
    ['-lead', 'x'],                                      // owner는 영숫자로 시작해야 함
    ['', 'x'], ['x', ''],                                // 빈 문자열
    [null, 'x'], ['x', undefined], [{}, 'x'],            // 비문자열
  ];
  for (const [owner, repo] of rejected) {
    assert.throws(
      () => assertRepoRef(owner, repo),
      GitHubInvalidRepoRefError,
      `허용되면 안 됨: owner=${JSON.stringify(owner)} repo=${JSON.stringify(repo)}`,
    );
    assert.equal(isValidRepoRef(owner, repo), false);
  }
});

test('assertGitHubApiUrl — 정상 경로는 절대 URL로 정규화해 돌려준다', () => {
  assert.equal(
    assertGitHubApiUrl('/repos/parnmanas/ai-workflow-board'),
    'https://api.github.com/repos/parnmanas/ai-workflow-board',
  );
  // encodeURIComponent 로 이미 인코딩된 세그먼트를 오탐하지 않는다 (release/1.0 브랜치)
  assert.equal(
    assertGitHubApiUrl('/repos/o/r/branches/release%2F1.0'),
    'https://api.github.com/repos/o/r/branches/release%2F1.0',
  );
  // URLSearchParams 로 만든 질의 문자열은 그대로 살아남는다
  assert.match(assertGitHubApiUrl('/search/code?q=a+b&per_page=5'), /\?q=a\+b&per_page=5$/);
});

test('assertGitHubApiUrl — traversal 세그먼트를 막아 api.github.com 밖/다른 엔드포인트 재조준을 차단한다', () => {
  for (const p of [
    '/repos/../../user',
    '/repos/x/../../user/repos',
    '/repos/./x',
    '/repos/%2e%2e/user',
    'repos/x/y',   // 선행 슬래시 없음
    '',
  ]) {
    assert.throws(() => assertGitHubApiUrl(p), GitHubInvalidRepoRefError, `허용되면 안 됨: ${JSON.stringify(p)}`);
  }
});

test('assertGitHubApiUrl — 원 익스플로잇이 실제로 닫혔다', () => {
  // 수정 전에는 아래가 https://api.github.com/user/repos?visibility=private& 로
  // 정규화되어 서버 토큰을 달고 나갔다.
  const owner = 'x';
  const repo = '../../user/repos?visibility=private&';
  assert.throws(() => assertGitHubApiUrl(`/repos/${owner}/${repo}`), GitHubInvalidRepoRefError);
  assert.throws(() => assertRepoRef(owner, repo), GitHubInvalidRepoRefError);
});

test('parseGitHubUrl — URL 경로로 들어오는 값도 같은 charset 규칙을 따른다', () => {
  assert.deepEqual(parseGitHubUrl('https://github.com/parnmanas/ai-workflow-board'), {
    owner: 'parnmanas',
    repo: 'ai-workflow-board',
  });
  assert.deepEqual(parseGitHubUrl('https://github.com/parnmanas/ai-workflow-board.git'), {
    owner: 'parnmanas',
    repo: 'ai-workflow-board',
  });
  // 파싱은 되지만 charset을 벗어나는 값은 REST 경로로 넘기지 않고 null 로 거부한다
  for (const url of [
    'https://github.com/../../user',
    'https://github.com/x/..',
    'https://github.com/-bad/repo',
    'not-a-github-url',
  ]) {
    assert.equal(parseGitHubUrl(url), null, `허용되면 안 됨: ${url}`);
  }
});
