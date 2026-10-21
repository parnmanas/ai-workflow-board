// 채팅 전용 작업 폴더 — agent-manager chat-workdirs.ts.
//
// 새 채팅에서 Agent 의 작업 폴더를 비우면 화면이 `<chat_workdir_root>/<이름>` 을 채운다. 매니저는
//   1. 하트비트로 그 루트를 알리고(구버전은 필드가 없다 → 화면이 폴더를 요구한다),
//   2. 디스패치 때 **그 루트 아래 경로만** 만든다 — 사용자가 고른 다른 폴더나 `..` 로 빠져나가는
//      경로는 만들지 않는다(없는 폴더는 그 사용자의 실수이고, 루트 밖에 폴더를 만들 이유가 없다).

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CHAT_WORKDIR_ROOT, ensureChatWorkdir, isUnderChatWorkdirRoot } from '../dist/lib/chat-workdirs.js';
import { InstanceHeartbeat } from '../dist/lib/instance-heartbeat.js';

test('ensureChatWorkdir creates only paths under the chat root', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'awb-chat-wd-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'chat-workdirs');

  assert.equal(await ensureChatWorkdir(join(root, 'claude'), root), true);
  assert.ok((await stat(join(root, 'claude'))).isDirectory());
  assert.equal(await ensureChatWorkdir(join(root, 'claude'), root), true, 'idempotent');

  assert.equal(await ensureChatWorkdir(join(base, 'elsewhere'), root), false);
  await assert.rejects(stat(join(base, 'elsewhere')), 'a folder outside the root is never created');
  assert.equal(await ensureChatWorkdir(`${root}/../escape`, root), false);
  assert.equal(await ensureChatWorkdir(root, root), false, 'the root itself is not an agent folder');
  assert.equal(await ensureChatWorkdir('relative/x', root), false);
  assert.equal(await ensureChatWorkdir('', root), false);
  assert.equal(isUnderChatWorkdirRoot(`${root}-other/x`, root), false, 'a sibling with the same prefix is not inside');
});

test('heartbeat advertises chat_workdir_root when wired', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let resolvePayload;
  const payload = new Promise((resolve) => { resolvePayload = resolve; });
  globalThis.fetch = async (_url, init) => {
    resolvePayload(JSON.parse(init.body));
    return new Response(null, { status: 204 });
  };
  const heartbeat = new InstanceHeartbeat(
    { url: 'http://awb.invalid', apiKey: 'secret', account_id: 'ws-1' },
    'manager-chat',
    { mode: 'manager', version: 'test', cli: 'mixed', cliAdapters: [], chatWorkdirRoot: CHAT_WORKDIR_ROOT },
  );
  t.after(() => heartbeat.stop());
  heartbeat.start();
  const body = await payload;
  assert.equal(body.chat_workdir_root, CHAT_WORKDIR_ROOT);
  assert.ok(CHAT_WORKDIR_ROOT.endsWith('chat-workdirs'));
});
