// win32 tree-kill 의 pid 재사용 가드 회귀 테스트 (ticket a992ce71).
//
// Windows 는 프로세스 그룹이 없어 `terminateDetachedProcessTree` 의 유일한 키가
// pid 인데, pid 는 프로세스가 죽는 즉시 OS 가 재사용한다. 죽은 자식의 pid 로
// grace(hermes 250ms / runtime-profiles 5000ms) 뒤에 `taskkill /T /F` 를 쏘면
// 그 사이 같은 pid 를 물려받은 **남의 프로세스**가 죽는다 — CI 에서는 형제
// 테스트 파일이 서브테스트 0개 · 출력 0줄 · exit 1 로 죽는 flake 로 나타났다.
// POSIX 에는 대응 가드(isGroupLeaderReused)가 있었지만 win32 에는 없었다.
//
// process-tree.ts 는 hostPlatform/runCommand 를 정적 import 하므로 리눅스에서는
// win32 분기를 그대로 태울 수 없다. 그래서 분기를 `terminateWindowsProcessTree`
// 로 떼어내고 run/sleep 을 주입 가능하게 뒀다 — 여기서 태우는 대상이 그것이다.
//
// Run: npm run build && node --test test/process-tree-win32-pid-reuse.test.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const { terminateWindowsProcessTree, childHasExited } = await import('../dist/lib/process-tree.js');

const OK = { code: 0, signal: null, stdout: '', stderr: '', spawnFailed: false, spawnError: '' };

/** taskkill 호출을 기록하는 가짜 runCommand. */
function recordingRun(calls) {
  return async (cmd, args) => {
    calls.push(`${cmd} ${args.join(' ')}`);
    return { ...OK };
  };
}

/** ChildProcess 의 종료 관측 부분만 흉내낸 스텁. */
function fakeChild({ exitCode = null, signalCode = null } = {}) {
  return { exitCode, signalCode };
}

test('이미 종료된 자식의 pid 로는 taskkill 을 한 번도 쏘지 않는다', async () => {
  const calls = [];
  await terminateWindowsProcessTree(4321, 250, {
    child: fakeChild({ exitCode: 0 }),
    run: recordingRun(calls),
    sleep: async () => {},
  });
  assert.deepEqual(calls, []);

  // 시그널로 죽은 경우도 같다 — exitCode 는 null 로 남고 signalCode 만 찬다.
  const bySignal = [];
  await terminateWindowsProcessTree(4321, 250, {
    child: fakeChild({ signalCode: 'SIGTERM' }),
    run: recordingRun(bySignal),
    sleep: async () => {},
  });
  assert.deepEqual(bySignal, []);
});

test('grace 도중 자식이 끝나면 force 패스를 쏘지 않는다', async () => {
  const calls = [];
  const child = fakeChild();
  await terminateWindowsProcessTree(4321, 250, {
    child,
    run: recordingRun(calls),
    // grace 를 실제로 기다리는 대신, 그 사이 자식이 종료한 상황을 만든다.
    sleep: async () => { child.exitCode = 0; },
  });
  assert.deepEqual(calls, ['taskkill /PID 4321 /T']);
});

test('grace 내내 살아 있으면 soft·force 를 모두 쏜다', async () => {
  const calls = [];
  await terminateWindowsProcessTree(4321, 250, {
    child: fakeChild(),
    run: recordingRun(calls),
    sleep: async () => {},
  });
  assert.deepEqual(calls, ['taskkill /PID 4321 /T', 'taskkill /PID 4321 /T /F']);
});

test('핸들을 못 주는 호출부는 종전 best-effort 경로 그대로다', async () => {
  const calls = [];
  await terminateWindowsProcessTree(4321, 250, {
    run: recordingRun(calls),
    sleep: async () => {},
  });
  assert.deepEqual(calls, ['taskkill /PID 4321 /T', 'taskkill /PID 4321 /T /F']);
});

test('childHasExited 는 정상 종료와 시그널 종료를 모두 종료로 본다', () => {
  assert.equal(childHasExited(fakeChild()), false);
  assert.equal(childHasExited(fakeChild({ exitCode: 0 })), true);
  assert.equal(childHasExited(fakeChild({ exitCode: 1 })), true);
  assert.equal(childHasExited(fakeChild({ signalCode: 'SIGKILL' })), true);
});

// 가드가 유용하려면 호출부가 실제로 핸들을 넘겨야 한다. 위 단위 테스트는
// terminateWindowsProcessTree 만 태우므로, 어느 호출부가 인자를 빠뜨려도
// 잡히지 않는다 — 이 정적 검사가 그 구멍을 막는다.
test('src/lib 의 모든 terminateDetachedProcessTree 호출부가 child 핸들을 넘긴다', () => {
  const libRoot = fileURLToPath(new URL('../src/lib/', import.meta.url));
  const tsFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? tsFiles(join(dir, entry.name))
      : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : []);

  const offenders = [];
  for (const file of tsFiles(libRoot)) {
    if (file.endsWith(join('lib', 'process-tree.ts'))) continue; // 정의 파일
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/terminateDetachedProcessTree\(([^;]*?)\)\s*[;.]/gs)) {
      if (!/\bchild\b/.test(match[1])) offenders.push(`${file}: ${match[0].trim()}`);
    }
  }
  assert.deepEqual(offenders, [], `pid 재사용 가드 없이 tree-kill 하는 호출부:\n${offenders.join('\n')}`);
});
