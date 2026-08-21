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

test('readRunWorkspaceLeaves: self-heal never clobbers a leaf recorded concurrently (리뷰 4라운드)', async () => {
  // 재현하려는 인터리빙: manifest=[stale1..staleN] 상태에서 readRunWorkspaceLeaves가
  // self-heal을 시작(자기 디렉터리가 사라졌음을 stat으로 확인 중)한 바로 그 사이,
  // recordRunWorkspaceLeaf가 새 leaf 'fresh'를 기록한다. self-heal의 read/stat이
  // lock 밖에서 일어나면(수정 전 코드) self-heal의 최종 write가 record 이전 시점의
  // 스냅샷을 그대로 써버려 'fresh'가 사라진다. read→stat→write 전체가 하나의
  // manifest lock 안에서 원자적으로 실행되면(수정 후) 어느 순서로 인터리빙되든
  // 최종 결과는 항상 ['fresh']여야 한다.
  const kindRoot = await makeKindRoot();

  // self-heal의 stat 루프가 여러 tick에 걸치도록 stale 항목을 다수 등록해 경합
  // 윈도우를 넓힌다 — record가 그 사이에 끼어들 시간을 벌어준다.
  const staleLeaves = ['stale-a', 'stale-b', 'stale-c', 'stale-d', 'stale-e'];
  for (const leaf of staleLeaves) {
    await fsp.mkdir(join(kindRoot, leaf), { recursive: true });
    await recordRunWorkspaceLeaf(kindRoot, leaf);
  }
  await Promise.all(staleLeaves.map((leaf) => fsp.rm(join(kindRoot, leaf), { recursive: true, force: true })));

  await fsp.mkdir(join(kindRoot, 'fresh'), { recursive: true });

  // 같은 tick에서 동시에 시작 — self-heal(읽기 시작)과 record(쓰기)가 경합하도록.
  const [selfHealResult] = await Promise.all([
    readRunWorkspaceLeaves(kindRoot),
    recordRunWorkspaceLeaf(kindRoot, 'fresh'),
  ]);

  // self-heal 자체가 반환한 값(둘 중 어느 순서로 인터리빙됐든 stale 항목은 전부
  // 빠져 있어야 한다 — 'fresh'는 self-heal이 record보다 먼저 lock을 잡았을 때는
  // 아직 안 보일 수 있으므로 여기서는 stale 누락만 확인한다)
  assert.ok(
    staleLeaves.every((l) => !selfHealResult.includes(l)),
    'self-heal 결과에 사라진 stale 항목이 남아있으면 안 됨',
  );

  // 최종 상태(양쪽 다 끝난 뒤)는 인터리빙 순서와 무관하게 'fresh' 하나만 남아야 한다.
  assert.deepEqual(await readRunWorkspaceLeaves(kindRoot), ['fresh']);
});

test('readRunWorkspaceLeaves: rejects manifest entries that are not normalized kind-root-relative paths', async () => {
  const kindRoot = await makeKindRoot();
  await fsp.mkdir(join(kindRoot, 'deploy'), { recursive: true });

  // 정상 항목(deploy) + 경로 이탈/절대경로/구분자 변형 후보들을 손으로 심어
  // corrupt/hand-edited manifest를 흉내낸다 — 전부 join(kindRoot, leaf)의
  // 입력이 되므로 read 경계에서 걸러져야 한다.
  await fsp.writeFile(
    join(dirname(kindRoot), '.act.manifest.json'),
    JSON.stringify(['deploy', '../evil', '/etc/passwd', 'a\\b', '', '.', '..', 'deploy/../../../etc', 'C:/windows']),
  );

  assert.deepEqual(await readRunWorkspaceLeaves(kindRoot), ['deploy']);
});
