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
