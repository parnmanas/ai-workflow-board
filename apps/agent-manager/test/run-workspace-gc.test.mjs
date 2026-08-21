// Action Run / 채팅방 워크스페이스 루트 + 아이들 GC (ticket 9fd27487 — 티켓이 아닌
// 실행 경로에는 폴더 관례가 없었다). 다루는 범위:
//   - actionWorkspaceRootFor / chatWorkspaceRootFor: runWorkspaceRootFor 와 대칭인
//     고정 루트(`.awb/act`, `.awb/chat`)
//   - sweepRunWorkspaces: `.awb-last-used` 마커(ticket 9fd27487 의 run-provisioner
//     추가분)를 기준으로 게이팅되는 아이들 회수 — 신선할 때는 회수되지 않고, 아이들
//     기준을 넘으면 회수되며, 마커 나이와 무관하게 폴더 안에 살아있는 프로세스가 있으면
//     절대 회수되지 않고, 마커가 없는 폴더는 디렉터리 자체의 mtime 으로 폴백한다
//   - snapshotRunWorkspaces: 인스턴스 하트비트를 위한 읽기 전용 프로젝션 형태
//     (path/kind/leaf/lastUsedAt/live), 아직 존재하지 않는 루트(해당 종류의 디스패치가
//     한 번도 없었던 경우)도 포함
//
// 컴파일된 모듈을 dist/ 에서 가져온다(`npm run build` 로 빌드됨).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

import {
  WorktreeManager,
  actionWorkspaceRootFor,
  chatWorkspaceRootFor,
  runWorkspaceRootFor,
} from '../dist/lib/worktree-manager.js';
import { recordRunWorkspaceLeaf } from '../dist/lib/run-workspace-manifest.js';

const manager = new WorktreeManager();

async function makeBase() {
  return fsp.mkdtemp(join(tmpdir(), 'awb-run-ws-gc-'));
}

// 7일이 RUN_WORKSPACE_IDLE_MS 다(export 되지 않음 — 테스트는 실제 경과 시간이 아니라
// 마커 파일의 내용(CONTENT)으로 나이를 제어하므로 정확히 일치할 필요는 없다;
// 경계를 넉넉히 넘거나 넉넉히 못 미치기만 하면 충분하다).
const WELL_PAST_IDLE = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
const WELL_WITHIN_IDLE = new Date(Date.now() - 60 * 1000).toISOString();

async function plantWorkspace(root, leaf, { marker } = {}) {
  const dir = join(root, leaf);
  await fsp.mkdir(dir, { recursive: true });
  if (marker !== undefined) {
    await fsp.writeFile(join(dir, '.awb-last-used'), marker);
  }
  return dir;
}

test('actionWorkspaceRootFor / chatWorkspaceRootFor: fixed roots symmetric with runWorkspaceRootFor', () => {
  const base = '/home/agent/work';
  assert.equal(actionWorkspaceRootFor(base), join(base, '.awb', 'act'));
  assert.equal(chatWorkspaceRootFor(base), join(base, '.awb', 'chat'));
  // 기존 QA/security 루트와 대칭적인 형태다 — join 패턴은 동일하고
  // leaf 세그먼트만 다르다.
  assert.equal(runWorkspaceRootFor(base), join(base, '.awb', 'qa'));
});

test('sweepRunWorkspaces: a fresh marker is NOT reclaimed', async () => {
  const base = await makeBase();
  const actRoot = actionWorkspaceRootFor(base);
  const dir = await plantWorkspace(actRoot, 'fresh-action', { marker: WELL_WITHIN_IDLE });

  const removed = await manager.sweepRunWorkspaces(base);
  assert.equal(removed, 0);
  await assert.doesNotReject(() => fsp.access(dir), 'fresh folder survives the sweep');
});

test('sweepRunWorkspaces: a marker past the idle bound IS reclaimed', async () => {
  const base = await makeBase();
  const chatRoot = chatWorkspaceRootFor(base);
  const dir = await plantWorkspace(chatRoot, 'stale-room', { marker: WELL_PAST_IDLE });

  const removed = await manager.sweepRunWorkspaces(base);
  assert.equal(removed, 1);
  await assert.rejects(() => fsp.access(dir), 'idle folder removed by the sweep');
});

test('sweepRunWorkspaces: a marker-less folder falls back to the directory mtime', async () => {
  const base = await makeBase();
  const actRoot = actionWorkspaceRootFor(base);
  // 마커가 기록되지 않음 — ticket 9fd27487 의 프로비저너 변경 이전 상태이거나,
  // 최초 프로비저닝이 마커를 touch 하기도 전에 죽은 경우다.
  const dir = await plantWorkspace(actRoot, 'no-marker-action');
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await fsp.utimes(dir, old, old);

  const removed = await manager.sweepRunWorkspaces(base);
  assert.equal(removed, 1, 'mtime fallback still reclaims an old, marker-less folder');
  await assert.rejects(() => fsp.access(dir));
});

test('sweepRunWorkspaces: NEVER reclaims a folder a live process currently sits inside, regardless of marker age', async () => {
  if (process.platform !== 'linux') return; // /proc 기반 liveness 체크는 Linux 전용이다
  const base = await makeBase();
  const actRoot = actionWorkspaceRootFor(base);
  const dir = await plantWorkspace(actRoot, 'live-action', { marker: WELL_PAST_IDLE });

  const child = spawn('sleep', ['5'], { cwd: dir, stdio: 'ignore' });
  try {
    // sweep 하기 전에 /proc/<pid>/cwd 가 해석될 시간을 준다.
    await new Promise((r) => setTimeout(r, 150));
    const removed = await manager.sweepRunWorkspaces(base);
    assert.equal(removed, 0, 'a live occupant blocks reclaim even past the idle bound');
    await assert.doesNotReject(() => fsp.access(dir));
  } finally {
    child.kill('SIGKILL');
    await once(child, 'exit').catch(() => {});
  }
});

test('sweepRunWorkspaces: sweeps both .awb/act and .awb/chat independently in one call', async () => {
  const base = await makeBase();
  const staleAction = await plantWorkspace(actionWorkspaceRootFor(base), 'stale-a', { marker: WELL_PAST_IDLE });
  const freshAction = await plantWorkspace(actionWorkspaceRootFor(base), 'fresh-a', { marker: WELL_WITHIN_IDLE });
  const staleChat = await plantWorkspace(chatWorkspaceRootFor(base), 'stale-c', { marker: WELL_PAST_IDLE });
  const freshChat = await plantWorkspace(chatWorkspaceRootFor(base), 'fresh-c', { marker: WELL_WITHIN_IDLE });

  const removed = await manager.sweepRunWorkspaces(base);
  assert.equal(removed, 2);
  await assert.rejects(() => fsp.access(staleAction));
  await assert.rejects(() => fsp.access(staleChat));
  await assert.doesNotReject(() => fsp.access(freshAction));
  await assert.doesNotReject(() => fsp.access(freshChat));
});

test('sweepRunWorkspaces: an empty/absent baseWorkingDir, or roots that were never provisioned, are a clean no-op', async () => {
  assert.equal(await manager.sweepRunWorkspaces(''), 0);
  const base = await makeBase(); // 존재는 하지만 .awb/act 나 .awb/chat 이 한 번도 생성된 적 없음
  assert.equal(await manager.sweepRunWorkspaces(base), 0);
});

test('snapshotRunWorkspaces: projects path/kind/leaf/lastUsedAt/live for the instance heartbeat', async () => {
  const base = await makeBase();
  await plantWorkspace(actionWorkspaceRootFor(base), 'snap-action', { marker: WELL_WITHIN_IDLE });
  await plantWorkspace(chatWorkspaceRootFor(base), 'snap-chat'); // 마커 없음 → lastUsedAt null

  const entries = await manager.snapshotRunWorkspaces(base);
  assert.equal(entries.length, 2);

  const action = entries.find((e) => e.kind === 'action');
  assert.equal(action.leaf, 'snap-action');
  assert.equal(action.path, join(actionWorkspaceRootFor(base), 'snap-action'));
  assert.equal(action.lastUsedAt, WELL_WITHIN_IDLE);
  assert.equal(action.live, false);

  const chat = entries.find((e) => e.kind === 'chat');
  assert.equal(chat.leaf, 'snap-chat');
  assert.equal(chat.lastUsedAt, null, 'marker-less folder projects lastUsedAt: null, not a thrown error');
});

test('snapshotRunWorkspaces: an empty baseWorkingDir yields [] (never throws)', async () => {
  assert.deepEqual(await manager.snapshotRunWorkspaces(''), []);
});

// 중첩 workspace_folder(예: 'deploy/scripts') 회귀 테스트 — 리뷰 지적(ticket
// 9fd27487): 기존 코드는 root의 직계 자식('deploy')만 leaf로 보고, 마커가 실제로
// 찍히는 최종 디렉터리('deploy/scripts')를 못 찾아 부모의 mtime으로 폴백했다.
// 부모는 자식의 git 활동으로 mtime이 갱신되지 않으므로, 방금 쓰인 자손 폴더가
// 안에 있어도 부모 전체가 통째로 재귀 삭제될 수 있었다.

test('sweepRunWorkspaces: nested workspace_folder — a stale PARENT mtime does not sweep a fresh nested leaf', async () => {
  const base = await makeBase();
  const actRoot = actionWorkspaceRootFor(base);
  const dir = await plantWorkspace(actRoot, 'deploy/scripts', { marker: WELL_WITHIN_IDLE });
  // plantWorkspace의 mkdir(recursive)가 만든 중간 디렉터리('deploy')는 방금
  // 생성되어 fresh하다 — 실제 버그 상황(오래전에 만들어진 뒤로 자식 git
  // 활동으로는 한 번도 갱신되지 않은 부모)을 재현하려면 인위적으로 되돌려야 한다.
  const parentDir = join(actRoot, 'deploy');
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await fsp.utimes(parentDir, old, old);

  const removed = await manager.sweepRunWorkspaces(base);
  assert.equal(removed, 0, '부모 mtime이 아니라 최종 leaf(scripts)의 마커로 판단해야 한다');
  await assert.doesNotReject(() => fsp.access(dir), '중첩 leaf가 부모째로 삭제되면 안 된다');
});

test('sweepRunWorkspaces: nested workspace_folder — a stale marker on the final nested leaf IS reclaimed', async () => {
  const base = await makeBase();
  const chatRoot = chatWorkspaceRootFor(base);
  const dir = await plantWorkspace(chatRoot, 'deploy/scripts', { marker: WELL_PAST_IDLE });

  const removed = await manager.sweepRunWorkspaces(base);
  assert.equal(removed, 1, '최종 leaf 자체가 idle이면(부모가 아니라) 정확히 회수되어야 한다');
  await assert.rejects(() => fsp.access(dir));
});

test('snapshotRunWorkspaces: nested workspace_folder projects leaf/path at the FINAL segment, not the parent container', async () => {
  const base = await makeBase();
  const actRoot = actionWorkspaceRootFor(base);
  await plantWorkspace(actRoot, 'deploy/scripts', { marker: WELL_WITHIN_IDLE });

  const entries = await manager.snapshotRunWorkspaces(base);
  assert.equal(entries.length, 1, '중첩 부모(deploy)를 별도 leaf로 이중 계산하면 안 된다');
  const [entry] = entries;
  assert.equal(entry.leaf, 'deploy/scripts');
  assert.equal(entry.path, join(actRoot, 'deploy', 'scripts'));
  assert.equal(entry.lastUsedAt, WELL_WITHIN_IDLE);
});

// 접두(prefix) 관계인 두 workspace_folder가 동시에 유효한 경우 회귀 테스트 —
// 리뷰 지적 2라운드(ticket 9fd27487): Action A가 workspace_folder='deploy',
// Action B가 workspace_folder='deploy/scripts'를 쓰면 둘 다 자기 자신의
// `.awb-last-used`를 갖는다. 1라운드 수정은 파일이 하나라도 있으면(마커 포함)
// 즉시 leaf로 확정하고 멈췄으므로 'deploy' 안에 중첩된 'deploy/scripts'를 별도
// leaf로 못 찾았다 — 'deploy'가 stale이면 재귀 삭제로 fresh한 'deploy/scripts'
// 까지 함께 날아가고, 'deploy'가 fresh이면 stale한 'deploy/scripts'가 영영
// 독립 회수되지 않았다.

test('sweepRunWorkspaces: sibling markers in a prefix relationship — a stale ANCESTOR does not sweep a fresh/live descendant', async () => {
  const base = await makeBase();
  const actRoot = actionWorkspaceRootFor(base);
  const parent = await plantWorkspace(actRoot, 'deploy', { marker: WELL_PAST_IDLE });
  const child = await plantWorkspace(actRoot, 'deploy/scripts', { marker: WELL_WITHIN_IDLE });

  const removed = await manager.sweepRunWorkspaces(base);
  assert.equal(removed, 0, '자손이 살아남으면 조상도 함께 지우면 안 된다(재귀 삭제가 자손까지 날린다)');
  await assert.doesNotReject(() => fsp.access(child), 'fresh 자손은 보존되어야 한다');
  await assert.doesNotReject(() => fsp.access(parent), 'stale 조상도 자손을 보호하느라 함께 보존되어야 한다');
});

test('sweepRunWorkspaces: sibling markers in a prefix relationship — a stale DESCENDANT is reclaimed independently of a fresh ancestor', async () => {
  const base = await makeBase();
  const chatRoot = chatWorkspaceRootFor(base);
  const parent = await plantWorkspace(chatRoot, 'deploy', { marker: WELL_WITHIN_IDLE });
  const child = await plantWorkspace(chatRoot, 'deploy/scripts', { marker: WELL_PAST_IDLE });

  const removed = await manager.sweepRunWorkspaces(base);
  assert.equal(removed, 1, 'stale 자손은 fresh 조상과 무관하게 독립적으로 회수되어야 한다');
  await assert.rejects(() => fsp.access(child), 'stale 자손은 제거되어야 한다');
  await assert.doesNotReject(() => fsp.access(parent), 'fresh 조상 자신(과 그 마커)은 보존되어야 한다');
});

test('snapshotRunWorkspaces: sibling markers in a prefix relationship both report as independent boundaries', async () => {
  const base = await makeBase();
  const actRoot = actionWorkspaceRootFor(base);
  await plantWorkspace(actRoot, 'deploy', { marker: WELL_PAST_IDLE });
  await plantWorkspace(actRoot, 'deploy/scripts', { marker: WELL_WITHIN_IDLE });

  const entries = await manager.snapshotRunWorkspaces(base);
  assert.equal(entries.length, 2, "'deploy'와 'deploy/scripts' 둘 다 독립 경계로 보고되어야 한다");
  const byLeaf = Object.fromEntries(entries.map((e) => [e.leaf, e]));
  assert.equal(byLeaf['deploy'].path, join(actRoot, 'deploy'));
  assert.equal(byLeaf['deploy'].lastUsedAt, WELL_PAST_IDLE);
  assert.equal(byLeaf['deploy/scripts'].path, join(actRoot, 'deploy', 'scripts'));
  assert.equal(byLeaf['deploy/scripts'].lastUsedAt, WELL_WITHIN_IDLE);
});

// 부모가 repo checkout(`.git` 보유)인 경우의 접두(prefix) 관계 회귀 테스트 —
// 리뷰 지적 3라운드(ticket 9fd27487): #listRunWorkspaceLeaves 는 `.git` 을 만나면
// 무조건 하강을 멈춘다. 저장/프로비저닝 어느 단계도 접두 충돌 자체를 거부하지
// 않으므로, Action A(workspace_folder='deploy', repo_ref 설정)가 `.awb/act/deploy`
// 를 자기 repo로 체크아웃한 뒤 Action B(workspace_folder='deploy/scripts')가 그
// 밑에 독립적으로 프로비저닝되는 상태가 실제로 허용된다 — 휴리스틱 단독으로는
// 'deploy/scripts' 를 절대 못 찾는다. run-workspace-manifest.ts 가 정확한 경계를
// 별도로 기록해 이 사각지대를 없앤다: 자식을 심을 때 provisionRunWorkspace가
// 실제로 하는 일(recordRunWorkspaceLeaf 호출)을 그대로 재현한다.
//
// `.git` 이 디렉터리(일반 clone)든 파일(linked worktree 의 gitdir 포인터)이든
// 휴리스틱은 이름만 보고 판정하므로 두 형태 모두 커버한다.
for (const gitAsFile of [false, true]) {
  const label = gitAsFile ? '.git 이 worktree형 파일인 경우' : '.git 이 디렉터리인 경우';

  test(`sweepRunWorkspaces + snapshotRunWorkspaces: repo-checkout 부모(${label}) 안에 manifest로 기록된 자식 — stale 부모는 fresh 자식과 함께 두 snapshot entry로 보고되고, 자식이 살아남으면 부모도 보존된다`, async () => {
    const base = await makeBase();
    const actRoot = actionWorkspaceRootFor(base);
    const parent = await plantWorkspace(actRoot, 'deploy', { marker: WELL_PAST_IDLE });
    if (gitAsFile) {
      await fsp.writeFile(join(parent, '.git'), 'gitdir: /elsewhere/.git/worktrees/deploy\n');
    } else {
      await fsp.mkdir(join(parent, '.git'), { recursive: true });
    }
    const child = await plantWorkspace(actRoot, 'deploy/scripts', { marker: WELL_WITHIN_IDLE });
    // provisionRunWorkspace가 Action B를 프로비저닝할 때마다 실제로 하는 일 —
    // 이 leaf를 manifest에 등록해서 부모의 `.git`이 하강을 막아도 독립 경계로
    // 남는다.
    await recordRunWorkspaceLeaf(actRoot, 'deploy/scripts');

    const snapshot = await manager.snapshotRunWorkspaces(base);
    assert.equal(snapshot.length, 2, "부모의 .git 이 하강을 막아도 'deploy/scripts' 가 별도 entry로 보고되어야 한다");
    const byLeaf = Object.fromEntries(snapshot.map((e) => [e.leaf, e]));
    assert.ok(byLeaf['deploy'], "'deploy' 자신도 독립 경계로 남아있어야 한다");
    assert.ok(byLeaf['deploy/scripts'], "'deploy/scripts' 가 manifest로 발견되어야 한다");

    const removed = await manager.sweepRunWorkspaces(base);
    assert.equal(removed, 0, '자손(deploy/scripts)이 fresh하면 stale 조상도 함께 지우면 안 된다');
    await assert.doesNotReject(() => fsp.access(child), 'fresh 자손은 보존되어야 한다');
    await assert.doesNotReject(() => fsp.access(parent), '자손을 보호하느라 stale 조상도 보존되어야 한다');
  });

  test(`sweepRunWorkspaces: repo-checkout 부모(${label}) 안에 manifest로 기록된 자식 — fresh 부모와 무관하게 stale 자식은 독립적으로 회수된다`, async () => {
    const base = await makeBase();
    const chatRoot = chatWorkspaceRootFor(base);
    const parent = await plantWorkspace(chatRoot, 'deploy', { marker: WELL_WITHIN_IDLE });
    if (gitAsFile) {
      await fsp.writeFile(join(parent, '.git'), 'gitdir: /elsewhere/.git/worktrees/deploy\n');
    } else {
      await fsp.mkdir(join(parent, '.git'), { recursive: true });
    }
    const child = await plantWorkspace(chatRoot, 'deploy/scripts', { marker: WELL_PAST_IDLE });
    await recordRunWorkspaceLeaf(chatRoot, 'deploy/scripts');

    const removed = await manager.sweepRunWorkspaces(base);
    assert.equal(removed, 1, 'manifest로 발견된 stale 자식은 fresh 조상과 무관하게 독립 회수되어야 한다');
    await assert.rejects(() => fsp.access(child), 'stale 자손은 제거되어야 한다');
    await assert.doesNotReject(() => fsp.access(parent), 'fresh 조상(과 그 .git)은 보존되어야 한다');
  });
}
