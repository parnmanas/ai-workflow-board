// run-workspace-manifest.ts 단위 테스트 (ticket 9fd27487, 리뷰 3라운드) — provisionRunWorkspace가
// 프로비저닝한 정확한 경계를 기록/조회/망각하는 작은 인덱스. 커버 범위:
//   - recordRunWorkspaceLeaf: 등록 + 멱등성 + 동시 기록이 서로를 지우지 않음
//   - forgetRunWorkspaceLeaf: 해당 leaf와 그 자손 leaf를 함께 제거
//   - readRunWorkspaceLeaves: 존재하지 않는/손상된 manifest는 [] 로 폴백하고,
//     디렉터리가 사라진 항목은 스스로 정리(self-heal)한다
//   - manifest 파일이 kind root(`.awb/act`) 바깥(형제 위치)에 저장되어, 그 자체가
//     휴리스틱 스캔의 "파일 하나라도 있으면 leaf" 판정을 오염시키지 않는다

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

import {
  recordRunWorkspaceLeaf,
  forgetRunWorkspaceLeaf,
  readRunWorkspaceLeaves,
} from '../dist/lib/run-workspace-manifest.js';

async function makeKindRoot() {
  const base = await fsp.mkdtemp(join(tmpdir(), 'awb-run-ws-manifest-'));
  const kindRoot = join(base, '.awb', 'act');
  await fsp.mkdir(kindRoot, { recursive: true });
  return kindRoot;
}

test('recordRunWorkspaceLeaf + readRunWorkspaceLeaves: round-trips a recorded leaf', async () => {
  const kindRoot = await makeKindRoot();
  await fsp.mkdir(join(kindRoot, 'deploy'), { recursive: true });
  await recordRunWorkspaceLeaf(kindRoot, 'deploy');
  assert.deepEqual(await readRunWorkspaceLeaves(kindRoot), ['deploy']);
});

test('recordRunWorkspaceLeaf: re-recording the same leaf is idempotent (no duplicate)', async () => {
  const kindRoot = await makeKindRoot();
  await fsp.mkdir(join(kindRoot, 'deploy'), { recursive: true });
  await recordRunWorkspaceLeaf(kindRoot, 'deploy');
  await recordRunWorkspaceLeaf(kindRoot, 'deploy');
  assert.deepEqual(await readRunWorkspaceLeaves(kindRoot), ['deploy']);
});

test('recordRunWorkspaceLeaf: concurrent recordings of DIFFERENT leaves under the same root do not clobber each other', async () => {
  const kindRoot = await makeKindRoot();
  await fsp.mkdir(join(kindRoot, 'deploy', 'scripts'), { recursive: true });
  await fsp.mkdir(join(kindRoot, 'other'), { recursive: true });
  await Promise.all([
    recordRunWorkspaceLeaf(kindRoot, 'deploy'),
    recordRunWorkspaceLeaf(kindRoot, 'deploy/scripts'),
    recordRunWorkspaceLeaf(kindRoot, 'other'),
  ]);
  const leaves = await readRunWorkspaceLeaves(kindRoot);
  assert.deepEqual(leaves.sort(), ['deploy', 'deploy/scripts', 'other']);
});

test('forgetRunWorkspaceLeaf: removes the leaf and any nested descendant leaf', async () => {
  const kindRoot = await makeKindRoot();
  await fsp.mkdir(join(kindRoot, 'deploy', 'scripts'), { recursive: true });
  await fsp.mkdir(join(kindRoot, 'other'), { recursive: true });
  await recordRunWorkspaceLeaf(kindRoot, 'deploy');
  await recordRunWorkspaceLeaf(kindRoot, 'deploy/scripts');
  await recordRunWorkspaceLeaf(kindRoot, 'other');

  await forgetRunWorkspaceLeaf(kindRoot, 'deploy');
  assert.deepEqual(await readRunWorkspaceLeaves(kindRoot), ['other']);
});

test('readRunWorkspaceLeaves: an absent manifest yields [] and never throws', async () => {
  const kindRoot = await makeKindRoot();
  assert.deepEqual(await readRunWorkspaceLeaves(kindRoot), []);
});

test('readRunWorkspaceLeaves: a corrupt manifest file yields [] and never throws', async () => {
  const kindRoot = await makeKindRoot();
  await fsp.writeFile(join(dirname(kindRoot), '.act.manifest.json'), 'not json{{{');
  assert.deepEqual(await readRunWorkspaceLeaves(kindRoot), []);
});

test('readRunWorkspaceLeaves: self-heals — an entry whose directory no longer exists is dropped', async () => {
  const kindRoot = await makeKindRoot();
  await fsp.mkdir(join(kindRoot, 'deploy'), { recursive: true });
  await recordRunWorkspaceLeaf(kindRoot, 'deploy');
  await fsp.rm(join(kindRoot, 'deploy'), { recursive: true, force: true }); // simulate an out-of-band removal

  assert.deepEqual(await readRunWorkspaceLeaves(kindRoot), []);
  // The self-heal write should have compacted the on-disk manifest too.
  assert.deepEqual(await readRunWorkspaceLeaves(kindRoot), []);
});

test('the manifest file is stored as a sibling of the kind root, not inside it', async () => {
  const kindRoot = await makeKindRoot();
  await fsp.mkdir(join(kindRoot, 'deploy'), { recursive: true });
  await recordRunWorkspaceLeaf(kindRoot, 'deploy');

  const insideRoot = await fsp.readdir(kindRoot);
  assert.deepEqual(insideRoot, ['deploy'], 'kind root must contain only real leaves, never the manifest file itself');
  await assert.doesNotReject(() => fsp.access(join(dirname(kindRoot), '.act.manifest.json')));
});
