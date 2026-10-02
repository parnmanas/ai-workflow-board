// 업데이터 → 예약 작업 인계 표식 + 재기동 경로 판정.
//
// ralf 실측(2026-10-03): 업데이터가 detached 자식을 직접 띄우면 그 프로세스는 예약
// 작업의 감시 밖이라 부팅 실패로 죽어도 RestartOnFailure 가 동작하지 않았다.
// 태스크가 있으면 `schtasks /Run` 으로 인계해 새 매니저가 감시 안에서 태어나게 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  consumeUpdateHandoff,
  resolveReexecStrategy,
  updateHandoffPath,
  writeUpdateHandoff,
  removeUpdateHandoff,
} from '../dist/lib/self-update.js';

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'awb-handoff-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('resolveReexecStrategy: systemd > windows task > detached', () => {
  assert.equal(resolveReexecStrategy({ systemdManaged: true, platform: 'win32', taskExists: true }), 'systemd');
  assert.equal(resolveReexecStrategy({ systemdManaged: false, platform: 'win32', taskExists: true }), 'task');
  assert.equal(resolveReexecStrategy({ systemdManaged: false, platform: 'win32', taskExists: false }), 'detached');
  assert.equal(resolveReexecStrategy({ systemdManaged: false, platform: 'linux' }), 'detached');
  assert.equal(resolveReexecStrategy({ systemdManaged: false, platform: 'darwin', taskExists: true }), 'detached');
});

test('consumeUpdateHandoff: 표식이 없으면 none', async (t) => {
  const dir = await scratch(t);
  assert.equal(await consumeUpdateHandoff({ dir, version: '1.6.265' }), 'none');
});

test('consumeUpdateHandoff: 깨진·다른 버전 표식은 stale 로 버린다', async (t) => {
  const dir = await scratch(t);
  await writeFile(updateHandoffPath(dir), 'not json {{{');
  assert.equal(await consumeUpdateHandoff({ dir, version: '1.6.265' }), 'stale');
  await assert.rejects(readFile(updateHandoffPath(dir)));
  await writeFile(updateHandoffPath(dir), JSON.stringify({ version: '1.6.264', pid: 999999, at: '' }));
  assert.equal(await consumeUpdateHandoff({ dir, version: '1.6.265' }), 'stale');
  await assert.rejects(readFile(updateHandoffPath(dir)));
});

test('consumeUpdateHandoff: 맞는 버전 + 죽은 pid 면 ready', async (t) => {
  const dir = await scratch(t);
  writeUpdateHandoff(dir, { version: '1.6.265', pid: 4194303, at: new Date().toISOString() });
  assert.equal(await consumeUpdateHandoff({ dir, version: '1.6.265' }), 'ready');
  await assert.rejects(readFile(updateHandoffPath(dir)), '소비한 표식은 지운다');
});

test('consumeUpdateHandoff: pid 가 안 죽으면 timeout 후 정상 획득으로 간다', async (t) => {
  const dir = await scratch(t);
  writeUpdateHandoff(dir, { version: '1.6.265', pid: process.pid, at: new Date().toISOString() });
  const r = await consumeUpdateHandoff({ dir, version: '1.6.265', pollMs: 5, timeoutMs: 60 });
  assert.equal(r, 'timeout');
  await assert.rejects(readFile(updateHandoffPath(dir)));
});

test('writeUpdateHandoff/removeUpdateHandoff 왕복', async (t) => {
  const dir = await scratch(t);
  writeUpdateHandoff(dir, { version: '9.9.9', pid: 1234, at: 't' });
  assert.deepEqual(JSON.parse(await readFile(updateHandoffPath(dir), 'utf8')).version, '9.9.9');
  removeUpdateHandoff(dir);
  await assert.rejects(readFile(updateHandoffPath(dir)));
  removeUpdateHandoff(dir);
});
