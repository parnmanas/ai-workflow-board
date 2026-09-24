// runWithSudo — 권한 상승 명령 하나를 돌리는 유일한 지점.
//
// 진짜 sudo 를 돌릴 수는 없으므로(비밀번호가 필요하고, 실패는 auth 로그를 더럽힌다)
// spawn 을 주입해 이 모듈이 실제로 책임지는 것만 본다:
//
//   1. 비밀번호가 **stdin 으로만** 간다 — argv 에도 env 에도 없다. 이게 무너지면
//      같은 호스트의 아무 프로세스나 /proc/<pid>/cmdline 으로 root 비밀번호를 읽는다.
//   2. `--` 뒤부터가 실행할 명령이다 — 없으면 argv 의 선행 `-x` 가 sudo 자신의
//      옵션으로 먹혀 호출자가 만든 명령과 실제로 도는 명령이 갈라진다.
//   3. `-k` 로 타임스탬프 캐시를 무효화한다 — 캐시가 살아 있으면 틀린 비밀번호로도
//      성공해 버려서 "이 비밀번호가 맞는가" 를 판정할 수 없다.
//   4. 실패 사유를 구분한다. 비밀번호 틀림 / 권한 없음 / sudo 없음 / 명령 실패는
//      운영자가 할 일이 서로 다르다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const { runWithSudo } = await import('../dist/lib/sudo-runner.js');

/** stdout/stderr 를 흉내내고 stdin 에 쓰인 바이트를 기록하는 가짜 child. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdinWrites = [];
  child.stdin = {
    end: (buf) => {
      // 호출자가 fill(0) 하기 전의 내용을 봐야 하므로 즉시 복사한다.
      child.stdinWrites.push(Buffer.from(buf).toString('utf8'));
    },
  };
  child.kill = () => {};
  return child;
}

/** spawn 을 가로채 (명령, argv, opts) 를 기록하고, 준비된 출력/종료코드를 흘린다. */
function spawnStub({ output = '', code = 0 } = {}) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    const child = fakeChild();
    calls.push({ cmd, args, opts, child });
    setImmediate(() => {
      if (output) child.stderr.emit('data', output);
      child.emit('close', code);
    });
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

test('비밀번호는 stdin 으로만 간다 — argv 와 env 에는 흔적도 없다', async () => {
  const spawn = spawnStub();
  await runWithSudo({ cmd: 'npm', args: ['--prefix', '/usr/local', 'install', '-g', 'x@latest'] }, 'hunter2', {
    spawn,
    platform: 'linux',
  });

  const call = spawn.calls[0];
  assert.equal(call.cmd, 'sudo');
  assert.equal(
    call.args.join(' ').includes('hunter2'),
    false,
    'argv 에 비밀번호가 새면 /proc/<pid>/cmdline 으로 아무나 읽는다',
  );
  assert.equal(
    JSON.stringify(call.opts.env ?? {}).includes('hunter2'),
    false,
    'env 에 비밀번호가 새면 자식 프로세스가 그대로 물려받는다',
  );
  assert.deepEqual(call.child.stdinWrites, ['hunter2\n']);
});

test('`--` 뒤부터가 실행할 명령이다 — 선행 대시가 sudo 옵션으로 먹히지 않는다', async () => {
  const spawn = spawnStub();
  await runWithSudo({ cmd: 'npm', args: ['--prefix', '/usr/local', 'install'] }, 'pw', {
    spawn,
    platform: 'linux',
  });

  const { args } = spawn.calls[0];
  const sep = args.indexOf('--');
  assert.ok(sep > 0, '`--` 구분자가 있어야 한다');
  assert.deepEqual(args.slice(sep + 1), ['npm', '--prefix', '/usr/local', 'install']);
  assert.ok(args.slice(0, sep).includes('-S'), '비밀번호를 stdin 에서 읽게 한다');
  assert.ok(args.slice(0, sep).includes('-k'), '타임스탬프 캐시를 무효화한다');
});

test('타임스탬프 캐시를 끄지 않으면 틀린 비밀번호로도 성공한다 — 그래서 -k 는 협상 대상이 아니다', async () => {
  const spawn = spawnStub();
  await runWithSudo({ cmd: 'true', args: [] }, 'pw', { spawn, platform: 'linux' });
  assert.ok(spawn.calls[0].args.includes('-k'));
});

test('성공하면 ok=true 이고 사유가 없다', async () => {
  const spawn = spawnStub({ output: 'added 1 package', code: 0 });
  const r = await runWithSudo({ cmd: 'npm', args: ['install'] }, 'pw', { spawn, platform: 'linux' });
  assert.deepEqual({ ok: r.ok, reason: r.reason }, { ok: true, reason: null });
  assert.match(r.output, /added 1 package/);
});

test('rolf 실측 출력으로 비밀번호 틀림을 알아본다', async () => {
  // 한 번의 실패가 세 줄을 뱉는다. 이 문구를 못 알아보면 운영자에게 "명령이
  // 실패했다" 고 말하게 되고, 정작 할 일(비밀번호 다시 입력)은 알려주지 못한다.
  const real = 'Sorry, try again.\n\nsudo: no password was provided\nsudo: 1 incorrect password attempt\n';
  const spawn = spawnStub({ output: real, code: 1 });
  const r = await runWithSudo({ cmd: 'true', args: [] }, 'wrong', { spawn, platform: 'linux' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_password');
});

test('한국어 로케일 호스트의 인증 실패도 같은 사유로 분류한다', async () => {
  const spawn = spawnStub({ output: 'sudo: 인증 실패\n', code: 1 });
  const r = await runWithSudo({ cmd: 'true', args: [] }, 'wrong', { spawn, platform: 'linux' });
  assert.equal(r.reason, 'bad_password', '영어 문구만 보면 로케일이 다른 호스트에서 오분류한다');
});

test('sudoers 에 없는 사용자는 비밀번호 문제와 구분한다 — 할 일이 다르다', async () => {
  const spawn = spawnStub({ output: 'parn is not allowed to execute /bin/foo as root', code: 1 });
  const r = await runWithSudo({ cmd: '/bin/foo', args: [] }, 'pw', { spawn, platform: 'linux' });
  assert.equal(r.reason, 'not_permitted');
});

test('인증은 통과하고 명령이 실패한 경우는 command_failed 다', async () => {
  const spawn = spawnStub({ output: 'npm ERR! ETIMEDOUT', code: 1 });
  const r = await runWithSudo({ cmd: 'npm', args: ['install'] }, 'pw', { spawn, platform: 'linux' });
  assert.equal(r.reason, 'command_failed');
  assert.match(r.output, /ETIMEDOUT/);
});

test('sudo 가 없으면(ENOENT) 그 사실을 따로 알린다', async () => {
  const spawn = (cmd, args, opts) => {
    const child = fakeChild();
    setImmediate(() => child.emit('error', Object.assign(new Error('spawn sudo ENOENT'), { code: 'ENOENT' })));
    return child;
  };
  const r = await runWithSudo({ cmd: 'true', args: [] }, 'pw', { spawn, platform: 'linux' });
  assert.equal(r.reason, 'no_sudo');
});

test('Windows 에서는 아예 시도하지 않는다 — sudo 라는 개념이 없다', async () => {
  const spawn = spawnStub();
  const r = await runWithSudo({ cmd: 'npm', args: [] }, 'pw', { spawn, platform: 'win32' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_sudo');
  assert.equal(spawn.calls.length, 0, '프로세스를 띄우지도 않는다');
});

test('상한을 넘기면 죽이고 timeout 으로 알린다', async () => {
  const spawn = (cmd, args, opts) => fakeChild(); // 아무 이벤트도 내지 않는다
  const r = await runWithSudo({ cmd: 'sleep', args: ['999'] }, 'pw', {
    spawn,
    platform: 'linux',
    timeoutMs: 30,
  });
  assert.equal(r.reason, 'timeout');
});
