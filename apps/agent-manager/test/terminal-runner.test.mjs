// Terminal(Runtime Host 셸) 러너 — docs/terminals.md.
//
// 가짜 PTY 를 주입해 서버와의 contract 를 고정한다:
//   1. open 이 terminal id 를 발급하고 셸을 고른 대로 띄운다(고르지 않으면 기본 셸),
//   2. 출력이 base64 청크로 서버에 중계되고 스크롤백은 상한 안에서 유지되며,
//   3. attach 가 그 스크롤백과 **절대 seq** 를 준다(화면이 라이브 청크와 중복을 거르는 근거),
//   4. input/resize 가 PTY 로 그대로 가고,
//   5. 프로세스가 끝나면 목록에서 빠진다 — 터미널은 기록이 없어 **살아 있는 것만** 존재한다.

import assert from 'node:assert/strict';
import test from 'node:test';

import { TerminalRunner } from '../dist/lib/terminal-runner.js';

const CONFIG = { url: 'http://awb.invalid', apiKey: 'secret', workspace_id: 'ws-1' };

/** 서버 호출을 가로채 (url, body) 를 모은다. */
function stubFetch(t) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

/** node-pty 흉내 — 테스트가 출력/종료를 직접 밀어 넣는다. */
function fakePty() {
  const spawned = [];
  const handles = [];
  const factory = (opts) => {
    spawned.push(opts);
    const handle = {
      pid: 4242 + handles.length,
      written: [],
      resized: [],
      killed: false,
      _data: null,
      _exit: null,
      onData(fn) { handle._data = fn; },
      onExit(fn) { handle._exit = fn; },
      write(data) { handle.written.push(data); },
      resize(cols, rows) { handle.resized.push([cols, rows]); },
      kill() { handle.killed = true; handle._exit?.({ exitCode: 0 }); },
    };
    handles.push(handle);
    return handle;
  };
  return { factory, spawned, handles };
}

function makeRunner(t, pty, opts = {}) {
  const runner = new TerminalRunner(CONFIG, {
    getManagerId: () => 'manager-1',
    ptyFactory: pty.factory,
    shellProvider: async () => ([
      { id: 'bash', label: 'bash', path: '/bin/bash', default: true },
      { id: 'sh', label: 'sh', path: '/bin/sh' },
    ]),
    flushIntervalMs: 5,
    idleHours: 0,
    ...opts,
  });
  t.after(() => { void runner.stopAll('test over'); });
  return runner;
}

const rpcOf = (calls) => calls.filter((c) => c.url.includes('/api/agent/terminals/rpc/')).map((c) => c.body);
const outputOf = (calls) => calls.filter((c) => c.url.includes('/output')).map((c) => c.body);
const req = (op, extra = {}) => ({ manager_id: 'manager-1', op, driver_user_id: 'user-1', issued_at: new Date().toISOString(), request_id: `rpc-${op}-${Math.random().toString(16).slice(2)}`, ...extra });
const decode = (chunk) => Buffer.from(chunk.data, 'base64').toString('utf8');

async function settle(ms = 30) {
  await new Promise((r) => setTimeout(r, ms));
}

test('terminal runner: open → output relay → attach snapshot → input/resize → exit drops it from the list', async (t) => {
  const calls = stubFetch(t);
  const pty = fakePty();
  const runner = makeRunner(t, pty);

  // 1. open — 고른 셸로 띄우고 id 를 돌려준다
  await runner.handle(req('open', { shell: 'sh', cwd: process.cwd(), title: 'build', cols: 100, rows: 30 }));
  const openResponse = rpcOf(calls).find((b) => b.result?.terminal_id);
  assert.ok(openResponse?.ok, 'open answers the RPC');
  const terminalId = openResponse.result.terminal_id;
  assert.equal(pty.spawned.length, 1);
  assert.equal(pty.spawned[0].file, '/bin/sh', 'the chosen shell is the one spawned');
  assert.equal(pty.spawned[0].cols, 100);
  assert.equal(pty.spawned[0].env.TERM, 'xterm-256color');
  assert.deepEqual(runner.liveStates(), [{ terminal_id: terminalId, status: 'live' }]);

  // 2. 출력 → base64 청크로 서버에 중계
  pty.handles[0]._data('hello ');
  pty.handles[0]._data('world\r\n');
  await settle(60);
  const relayed = outputOf(calls).flatMap((b) => b.chunks);
  assert.ok(relayed.length >= 1, 'output reaches the server');
  assert.equal(relayed.map(decode).join(''), 'hello world\r\n');
  assert.ok(relayed.every((c) => c.seq > 0), 'chunks carry an absolute seq');

  // 3. attach — 스크롤백 전체와 마지막 seq
  calls.length = 0;
  await runner.handle(req('attach', { terminal_id: terminalId, cols: 80, rows: 24 }));
  const attach = rpcOf(calls).at(-1);
  assert.ok(attach?.ok, 'attach answers the RPC');
  assert.equal(Buffer.from(attach.result.data, 'base64').toString('utf8'), 'hello world\r\n');
  assert.equal(attach.result.seq, relayed.at(-1).seq, 'the snapshot ends at the last relayed chunk');
  assert.equal(attach.result.truncated, false);
  assert.deepEqual(pty.handles[0].resized.at(-1), [80, 24], 'attaching with a size resizes the PTY');

  // 4. input / resize 는 그대로 PTY 로
  await runner.handle(req('input', { terminal_id: terminalId, data: 'ls\r' }));
  assert.deepEqual(pty.handles[0].written, ['ls\r']);
  await runner.handle(req('resize', { terminal_id: terminalId, cols: 120, rows: 40 }));
  assert.deepEqual(pty.handles[0].resized.at(-1), [120, 40]);

  // 5. list — 살아 있는 것만
  calls.length = 0;
  await runner.handle(req('list'));
  const list = rpcOf(calls).at(-1);
  assert.deepEqual(list.result.terminals.map((tm) => tm.terminal_id), [terminalId]);
  assert.equal(list.result.terminals[0].pid, pty.handles[0].pid);

  // 6. 셸이 끝나면 라이브 목록에서 빠지고 상태 패치가 나간다
  calls.length = 0;
  pty.handles[0]._exit({ exitCode: 3 });
  await settle(60);
  assert.deepEqual(runner.liveStates(), [], 'an exited terminal is not live');
  const exitPatch = outputOf(calls).map((b) => b.state).filter(Boolean).at(-1);
  assert.equal(exitPatch?.status, 'exited');
  assert.equal(exitPatch?.exit_code, 3);
  calls.length = 0;
  await runner.handle(req('list'));
  assert.deepEqual(rpcOf(calls).at(-1).result.terminals, [], 'the list only ever shows live terminals');
});

test('terminal runner: no shell chosen uses the default, unknown shell is refused, scrollback is bounded', async (t) => {
  const calls = stubFetch(t);
  const pty = fakePty();
  const runner = makeRunner(t, pty, { scrollbackBytes: 64 });

  await runner.handle(req('open', { cwd: process.cwd() }));
  assert.equal(pty.spawned[0].file, '/bin/bash', 'no shell chosen → the host default');
  const terminalId = rpcOf(calls).find((b) => b.result?.terminal_id).result.terminal_id;

  calls.length = 0;
  await runner.handle(req('open', { shell: 'nushell' }));
  const refusal = rpcOf(calls).at(-1);
  assert.equal(refusal.ok, false);
  assert.equal(refusal.code, 'shell_unknown');
  assert.equal(pty.spawned.length, 1, 'an unknown shell never spawns anything');

  // 스크롤백 상한을 넘기면 오래된 것부터 버리고 truncated 를 세운다.
  for (let i = 0; i < 10; i += 1) pty.handles[0]._data(`line-${i}-padding-padding\r\n`);
  await settle(60);
  calls.length = 0;
  await runner.handle(req('attach', { terminal_id: terminalId }));
  const attach = rpcOf(calls).at(-1);
  const snapshot = Buffer.from(attach.result.data, 'base64').toString('utf8');
  assert.ok(attach.result.truncated, 'dropping the oldest bytes is reported');
  assert.ok(snapshot.length <= 64 + 32, `snapshot stays near the cap (got ${snapshot.length})`);
  assert.ok(snapshot.includes('line-9'), 'the most recent output is what survives');
  assert.equal(snapshot.includes('line-0'), false, 'the oldest output is the part dropped');
});

test('terminal runner: close kills the PTY and attach on an unknown id is a not_found RPC answer', async (t) => {
  const calls = stubFetch(t);
  const pty = fakePty();
  const runner = makeRunner(t, pty);

  await runner.handle(req('open', { cwd: process.cwd() }));
  const terminalId = rpcOf(calls).find((b) => b.result?.terminal_id).result.terminal_id;

  await runner.handle(req('close', { terminal_id: terminalId }));
  await settle(40);
  assert.equal(pty.handles[0].killed, true);
  assert.deepEqual(runner.liveStates(), []);

  calls.length = 0;
  await runner.handle(req('attach', { terminal_id: 'term-nope' }));
  const answer = rpcOf(calls).at(-1);
  assert.equal(answer.ok, false);
  assert.equal(answer.code, 'not_found');
});

test('terminal runner: with no PTY module and no injected factory the host reports no shells', async (t) => {
  stubFetch(t);
  // ptyFactory 를 주지 않으면 러너가 `@lydell/node-pty` 를 찾는다. 테스트 환경에 있든
  // 없든, 셸 목록이 비면 서버가 이 장비를 터미널 목록에서 빼는 것이 contract 다.
  const runner = new TerminalRunner(CONFIG, {
    getManagerId: () => 'manager-1',
    shellProvider: async () => [],
    idleHours: 0,
  });
  t.after(() => { void runner.stopAll('test over'); });
  assert.deepEqual(await runner.availableShells(), []);
});
