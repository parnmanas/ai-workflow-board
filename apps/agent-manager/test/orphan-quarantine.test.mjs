// orphan 격리(quarantine) — 죽이지 못한 stale CLI 가 부팅을 죽이지 않는다.
//
// ralf 실측(2026-10-03): 끝나지 않은 CLI 하나 때문에 부팅 전체가 exit 1 로 죽고,
// 업데이터가 띄운 프로세스라 재시작 장치도 없어 장시간 다운됐다. 이제 죽이지 못한
// 항목은 격리 파일에 남기고 부팅은 계속된다. 다음 부팅이 새 예산으로 다시 정리한다:
//   - 죽은 pid → sidecar 정리 + 격리 해제
//   - 살아 있는 pid → hasLiveQuarantine() 이 true 를 유지해 resume 을 fresh 로 강제
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  cleanupOrphanSubagents,
  hasLiveQuarantine,
  readQuarantine,
} from '../dist/lib/orphan-cleanup.js';

/** 죽은 것이 확실한 pid — 현재 프로세스보다 훨씬 큰 값은 존재할 수 없다. */
const DEAD_PID = 4194303;

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'awb-quarantine-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('죽은 pid 의 격리 항목은 다음 정리에서 sidecar 와 함께 해제된다', async (t) => {
  const dir = await scratch(t);
  await writeFile(join(dir, 'cfg-x.pid'), String(DEAD_PID));
  await writeFile(join(dir, 'cfg-x.json'), '{}');
  await writeFile(
    join(dir, 'quarantine.json'),
    JSON.stringify([{ pid: DEAD_PID, entry: 'cfg-x.pid', reason: 'did not exit', at: new Date().toISOString() }]),
  );
  const r = await cleanupOrphanSubagents(dir, false);
  assert.equal(r.failed ?? 0, 0);
  await assert.rejects(readFile(join(dir, 'cfg-x.pid')), '죽은 항목의 sidecar 는 지운다');
  await assert.rejects(readFile(join(dir, 'quarantine.json')), '격리 파일도 비면 지운다');
  assert.equal(await hasLiveQuarantine(dir), false);
});

test('hasLiveQuarantine: 살아 있는 pid 가 하나라도 있으면 true', async (t) => {
  const dir = await scratch(t);
  assert.equal(await hasLiveQuarantine(dir), false, '파일이 없으면 false');
  await writeFile(join(dir, 'quarantine.json'), JSON.stringify([{ pid: DEAD_PID, entry: 'gone.pid', reason: 'x', at: '' }]));
  assert.equal(await hasLiveQuarantine(dir), false, '죽은 pid 만 있으면 false');
  await writeFile(
    join(dir, 'quarantine.json'),
    JSON.stringify([
      { pid: DEAD_PID, entry: 'gone.pid', reason: 'x', at: '' },
      { pid: process.pid, entry: 'live.pid', reason: 'did not exit', at: '' },
    ]),
  );
  assert.equal(await hasLiveQuarantine(dir), true, '살아 있는 pid 가 섞여 있으면 true');
  const entries = await readQuarantine(dir);
  assert.equal(entries.length, 2);
});

test('깨진 격리 파일은 버리고 빈 목록으로 둔다', async (t) => {
  const dir = await scratch(t);
  await writeFile(join(dir, 'quarantine.json'), 'not json {{{');
  assert.deepEqual(await readQuarantine(dir), []);
  await assert.rejects(readFile(join(dir, 'quarantine.json')), '깨진 파일은 삭제한다');
});

test('깨끗한 정리 결과에도 failedPids 계약이 있다', async (t) => {
  const dir = await scratch(t);
  const r = await cleanupOrphanSubagents(dir, false);
  assert.deepEqual([r.scanned, r.reaped, r.failed ?? 0, r.failedPids ?? null], [0, 0, 0, []]);
});
