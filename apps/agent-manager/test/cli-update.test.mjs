// runCliUpdate — 호스트에 설치된 CLI 를 어댑터의 자체 업데이터로 올린다.
//
// 진짜 `claude update` / `codex update` 를 돌릴 수는 없으므로 spawn 과 버전 probe 를
// 주입해, 이 모듈이 실제로 책임지는 것만 본다: 어댑터에서 argv 를 받아 왔는지,
// 전후 버전을 각각 다시 읽는지, 실패·미지원을 throw 없이 구분해 돌려주는지.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { runCliUpdate } = await import('../dist/lib/cli-update.js');

function versionProbe(sequence) {
  const values = [...sequence];
  return async () => (values.length > 1 ? values.shift() : values[0]);
}

test('claude 는 `update` 서브커맨드를 돌리고 전후 버전을 각각 다시 읽는다', async () => {
  const runs = [];
  const result = await runCliUpdate('claude', {
    hostLabel: 'rolf',
    run: async (bin, args) => {
      runs.push({ bin, args });
      return { ok: true, output: 'Updated to 2.1.0' };
    },
    probeVersion: versionProbe(['2.0.0', '2.1.0']),
  });

  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].args, ['update']);
  assert.match(runs[0].bin, /claude/, '어댑터가 해석한 바이너리 경로로 돌린다');
  assert.deepEqual(
    { supported: result.supported, ok: result.ok, before: result.before, after: result.after },
    { supported: true, ok: true, before: '2.0.0', after: '2.1.0' },
  );
  assert.equal(result.hostLabel, 'rolf');
});

test('codex 도 같은 계약을 따른다', async () => {
  const runs = [];
  await runCliUpdate('codex', {
    run: async (bin, args) => {
      runs.push(args);
      return { ok: true, output: '' };
    },
    probeVersion: versionProbe(['0.9.0']),
  });
  assert.deepEqual(runs, [['update']]);
});

test('업데이터가 실패하면 ok=false 로 돌려주고 출력 꼬리를 detail 에 남긴다 (throw 하지 않는다)', async () => {
  const result = await runCliUpdate('claude', {
    run: async () => ({ ok: false, output: 'npm ERR! code EACCES\nnpm ERR! permission denied' }),
    probeVersion: versionProbe(['2.0.0']),
  });

  assert.equal(result.supported, true);
  assert.equal(result.ok, false);
  assert.match(result.detail, /EACCES/);
  // 실패해도 after 는 다시 읽는다 — 부분 업데이트로 버전이 바뀌었을 수 있다.
  assert.equal(result.after, '2.0.0');
});

test('아주 긴 출력은 꼬리만 남겨 ack 메시지가 로그를 통째로 삼키지 않게 한다', async () => {
  const result = await runCliUpdate('claude', {
    run: async () => ({ ok: false, output: `${'x'.repeat(5000)}FINAL ERROR` }),
    probeVersion: versionProbe([null]),
  });

  assert.ok(result.detail.length < 500, `detail 이 잘려야 한다 (len=${result.detail.length})`);
  assert.match(result.detail, /FINAL ERROR$/, '마지막 줄(실패 사유)은 반드시 남는다');
});

test('자체 업데이터가 없는 CLI 는 supported=false 로 돌아오고 아무것도 실행하지 않는다', async () => {
  let ran = 0;
  const result = await runCliUpdate('pi', {
    run: async () => {
      ran++;
      return { ok: true, output: '' };
    },
    probeVersion: versionProbe(['1.0.0']),
  });

  assert.equal(ran, 0);
  assert.equal(result.supported, false);
  assert.equal(result.ok, false);
});

test('알 수 없는 CLI 는 throw 대신 해석 실패 사유를 담아 돌아온다', async () => {
  let ran = 0;
  const result = await runCliUpdate('not-a-cli', {
    run: async () => {
      ran++;
      return { ok: true, output: '' };
    },
    probeVersion: versionProbe(['1.0.0']),
  });

  assert.equal(ran, 0);
  assert.equal(result.supported, false);
  assert.match(result.detail, /not-a-cli/);
});

// ─── 하트비트의 cli_versions ────────────────────────────────────────────────
//
// 업데이트 결과가 UI 에 닿는 유일한 경로. 모델 목록과 같은 provider 계약을
// 따른다 — 매 tick 다시 읽고, 실패해도 하트비트를 멈추지 않는다.

const { InstanceHeartbeat } = await import('../dist/lib/instance-heartbeat.js');

function collectFetch(t) {
  const originalFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(null, { status: 204 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return bodies;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const heartbeatConfig = () => ({ url: 'http://awb.invalid', apiKey: 'secret', workspace_id: 'ws-1' });

test('하트비트는 cliVersionsProvider 를 매 tick 다시 읽는다 — update_cli 결과가 재시작 없이 실린다', async (t) => {
  const bodies = collectFetch(t);
  let versions = { claude: '2.0.0', codex: '0.9.0' };
  const heartbeat = new InstanceHeartbeat(heartbeatConfig(), 'manager-cli-1', {
    mode: 'manager',
    version: 'test',
    cli: 'mixed',
    cliAdapters: [],
    cliVersionsProvider: () => versions,
  });
  t.after(() => heartbeat.stop());

  heartbeat.start();
  await flush();
  assert.deepEqual(bodies[0].cli_versions, { claude: '2.0.0', codex: '0.9.0' });

  versions = { claude: '2.1.0', codex: '0.9.0' };
  await heartbeat.postNow();
  assert.deepEqual(bodies[1].cli_versions, { claude: '2.1.0', codex: '0.9.0' });
});

test('cliVersionsProvider 가 throw 하거나 없으면 필드만 빠지고 하트비트는 계속 돈다', async (t) => {
  const bodies = collectFetch(t);
  const exploding = new InstanceHeartbeat(heartbeatConfig(), 'manager-cli-2', {
    mode: 'manager',
    version: 'test',
    cli: 'mixed',
    cliAdapters: [],
    cliVersionsProvider: () => {
      throw new Error('probe 폭발');
    },
  });
  t.after(() => exploding.stop());
  exploding.start();
  await flush();
  assert.equal('cli_versions' in bodies[0], false);
  assert.equal(bodies[0].mode, 'manager', '나머지 하트비트 필드는 그대로 실린다');

  const legacy = new InstanceHeartbeat(heartbeatConfig(), 'manager-cli-3', {
    mode: 'manager',
    version: 'test',
    cli: 'mixed',
    cliAdapters: [],
  });
  t.after(() => legacy.stop());
  await legacy.postNow();
  assert.equal('cli_versions' in bodies[1], false);
});
