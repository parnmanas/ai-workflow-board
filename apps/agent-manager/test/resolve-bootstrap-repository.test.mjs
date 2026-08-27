// resolveBootstrapRepository (ticket 112ea3c5) — WorktreeManager.resolveCwd의
// `bootstrapRepo`를 채울 repo/branch를 고르는 순수 함수. 모든 다운스트림
// worktree 경로(`.awb/wt/<resourceSlug>/…`)가 이 값 하나로 격리된다. 서버의
// `pickBaseRepoResourceId`(base-repo-binding.ts) 우선순위(ticket 자체 repo가
// 우선, 없으면 board environment의 첫 repo)를 그대로 따르는데, 전용 테스트가
// 전무했다 — SSE wire shape(서버 `agent_trigger` flatten)만 커버됐고
// (apps/server/test/base-repo-binding.test.mjs), 이 함수 자체의 계약은 아무도
// 고정하지 않았다. 여기서 조용히 어긋나면(예: env.repositories[0] 대신 [1]을
// 고르거나, 빈 ticket url을 trim하지 않는 등) 기존 테스트는 하나도 실패하지
// 않으면서 워크트리 트리 전체가 잘못된 곳을 가리키게 된다.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveBootstrapRepository } from '../dist/lib/event-dispatcher.js';

const TICKET_REPO = {
  id: 'ticket-resource',
  name: 'Ticket Repo',
  url: 'https://github.com/acme/ticket-repo.git',
  default_branch: 'develop',
};

function env(repositories) {
  return {
    repositories,
    env_vars: {},
    setup_commands: [],
    setup_timeout_seconds: 600,
    version: 0,
  };
}

const BOARD_ENV = env([
  { resource_id: 'board-resource', url: 'https://github.com/acme/board-repo.git', target_dir: 'repos/board-repo', branch: 'main', post_clone_commands: [] },
]);

test('ticket repo wins over the board environment (ticket > board priority)', () => {
  const picked = resolveBootstrapRepository(TICKET_REPO, 'feature/x', BOARD_ENV);
  assert.deepEqual(picked, { resourceId: 'ticket-resource', url: 'https://github.com/acme/ticket-repo.git', branch: 'feature/x', defaultBranch: 'develop' });
});

test('ticket repo with no explicit branch falls back to the ticket repo\'s OWN default_branch (not the board env repo\'s)', () => {
  const picked = resolveBootstrapRepository(TICKET_REPO, '', BOARD_ENV);
  assert.deepEqual(picked, { resourceId: 'ticket-resource', url: 'https://github.com/acme/ticket-repo.git', branch: 'develop', defaultBranch: 'develop' });
});

test('ticket repo with whitespace-only branch is treated as empty and falls back to the repo default_branch', () => {
  const picked = resolveBootstrapRepository(TICKET_REPO, '   ', BOARD_ENV);
  assert.equal(picked.branch, 'develop');
});

test('empty ticket repo (base_repo: null) falls back to the board environment\'s first repository', () => {
  const picked = resolveBootstrapRepository(null, null, BOARD_ENV);
  assert.deepEqual(picked, { resourceId: 'board-resource', url: 'https://github.com/acme/board-repo.git', branch: 'main', defaultBranch: null });
});

test('inherited repo snapshot + empty ticket base_branch + board branch != resource default_branch → the resolved (board) branch wins', () => {
  // 리뷰 지적(ticket 112ea3c5): 서버가 board environment entry 자체의 branch
  // 오버라이드("release")를 resource의 default_branch("main")보다 우선해
  // baseBranch로 먼저 계산해 넘겨준다는 전제를, 이 함수의 관점에서 고정한다.
  // baseRepo는 이미 상속된 스냅샷(server의 board-env 백필 결과)이고, 그
  // default_branch는 resource 고유값("main")일 뿐 board가 지정한 branch를
  // 담지 않는다 — 그래서 서버가 계산한 유효 branch("release")는 반드시
  // baseBranch 파라미터로 전달돼야 하고, 이 함수는 그 explicit 값을
  // repo.default_branch보다 우선해야 한다.
  const inheritedRepo = {
    id: 'board-resource',
    url: 'https://github.com/acme/board-repo.git',
    default_branch: 'main', // resource 고유 default — board가 지정한 "release"가 아님
  };
  const picked = resolveBootstrapRepository(inheritedRepo, 'release', BOARD_ENV);
  assert.deepEqual(picked, { resourceId: 'board-resource', url: 'https://github.com/acme/board-repo.git', branch: 'release', defaultBranch: 'main' });
  assert.notEqual(picked.branch, inheritedRepo.default_branch, 'board가 지정한 branch가 resource default로 조용히 덮여쓰이면 안 된다');
});

test('ticket repo object present but url is empty/whitespace is treated as no ticket repo (falls to board env)', () => {
  // 방어적 케이스: 손상/부분 ticket.base_repo(id는 있는데 url이 빈 값)가
  // 빈 url로 "이겨서는" 절대 안 된다 — 그러면 WorktreeManager에 clone할 게
  // 없는 resourceId를 넘기게 된다.
  for (const badUrl of ['', '   ', undefined, null]) {
    const picked = resolveBootstrapRepository({ id: 'ticket-resource', url: badUrl, default_branch: 'develop' }, '', BOARD_ENV);
    assert.equal(picked.resourceId, 'board-resource', `url=${JSON.stringify(badUrl)} must fall back to board env`);
  }
});

test('no ticket repo and no environment repositories → null (nothing to bootstrap)', () => {
  assert.equal(resolveBootstrapRepository(null, null, null), null);
  assert.equal(resolveBootstrapRepository(null, null, env([])), null);
});

test('baseRepo of the wrong shape (string / number / array) is treated as absent, not thrown on', () => {
  for (const bad of ['not-an-object', 42, ['a', 'b']]) {
    assert.equal(resolveBootstrapRepository(bad, null, null), null);
    assert.deepEqual(resolveBootstrapRepository(bad, null, BOARD_ENV), {
      resourceId: 'board-resource', url: 'https://github.com/acme/board-repo.git', branch: 'main', defaultBranch: null,
    });
  }
});

test('multiple environment repositories → deterministically takes [0], never a later entry', () => {
  // ticket 112ea3c5 근본원인 가드: 보드당 관리되는 default는 하나만 의도된다
  // (write 경로가 environment_config.repositories를 1개로 캡 — apps/server/
  // src/common/environment-config.ts EnvironmentConfigInputSchema) — 하지만
  // READ 경로는 레거시 multi-entry row를 위해 여전히 permissive하다. 이
  // 함수가 [0] 고정 대신 순회했다면, 오래된 두 번째 entry가 board 기본값을
  // 상속하는 모든 티켓을 조용히 다른 곳으로 돌릴 수 있었다.
  const multi = env([
    { resource_id: 'first-resource', url: 'https://github.com/acme/first.git', target_dir: 'repos/first', branch: 'main', post_clone_commands: [] },
    { resource_id: 'second-resource', url: 'https://github.com/acme/second.git', target_dir: 'repos/second', branch: 'main', post_clone_commands: [] },
  ]);
  const picked = resolveBootstrapRepository(null, null, multi);
  assert.equal(picked.resourceId, 'first-resource');
  assert.notEqual(picked.resourceId, 'second-resource');
});

test('board env repository with no resource_id still resolves (agent-manager is permissive; the server-side pend guard is the strict gate)', () => {
  // 서버의 pickBaseRepoResourceId와의 의도된 비대칭: 서버는 resource_id가
  // 없으면 push credential을 못 구하니 url-only env entry를 건너뛴다(
  // base-repo-binding.test.mjs "url-only environment repos... are NOT a valid
  // fallback" 참고). agent-manager는 read-only 역할 dispatch라면 그 url을
  // 그대로 checkout에 쓸 수 있다 — 이 테스트는 그 비대칭이 정확히 이 필드
  // 하나뿐이고 더 넓게 번지지 않았음을 고정한다.
  const urlOnly = env([{ resource_id: '', url: 'https://github.com/acme/url-only.git', target_dir: 'repos/url-only', branch: '', post_clone_commands: [] }]);
  const picked = resolveBootstrapRepository(null, null, urlOnly);
  assert.deepEqual(picked, { resourceId: '', url: 'https://github.com/acme/url-only.git', branch: '', defaultBranch: null });
});
