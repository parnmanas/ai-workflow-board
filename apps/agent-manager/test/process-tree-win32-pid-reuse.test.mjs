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

/** ChildProcess 의 종료 관측 부분만 흉내낸 스텁. `once` 가 없으므로 구현은
 *  "기다릴 수 없는 핸들" 경로(예산만큼 sleep)로 떨어진다. */
function fakeChild({ exitCode = null, signalCode = null } = {}) {
  return { exitCode, signalCode };
}

/** 'exit' 를 구독시켜 주는 핸들 — 실제 ChildProcess 에 대응한다. `emitExit()`
 *  로 종료를 발생시키면 대기 중이던 쪽이 예산을 다 쓰지 않고 깨어난다. */
function fakeEventChild() {
  const listeners = new Set();
  return {
    exitCode: null,
    signalCode: null,
    once(event, listener) { if (event === 'exit') listeners.add(listener); },
    off(event, listener) { if (event === 'exit') listeners.delete(listener); },
    get listenerCount() { return listeners.size; },
    emitExit(code = 0) {
      this.exitCode = code;
      for (const l of [...listeners]) { listeners.delete(l); l(); }
    },
  };
}

/** sleep 호출 예산을 기록하는 스텁. 실제로 기다리지는 않는다. */
function recordingSleep(budgets, onSleep) {
  return async (ms) => { budgets.push(ms); if (onSleep) await onSleep(budgets.length); };
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

// 호출부는 kill 을 보낸 직후 우리를 부르므로 그 시점 핸들은 아직 exitCode 가
// null 이다. 이걸 기다려서 관측하지 않으면 가드가 실전에서 발동하지 못한다 —
// windows CI 실측에서 진입 게이트 0회 대 무의미한 soft taskkill 29회였다.
test('진입 직후엔 아직 exit 를 못 봤어도, 관측 예산 안에 끝나면 taskkill 을 안 쏜다', async () => {
  const calls = [];
  const budgets = [];
  const child = fakeChild();
  await terminateWindowsProcessTree(4321, 250, {
    child,
    run: recordingRun(calls),
    // 관측 예산 동안 자식이 종료한 상황.
    sleep: recordingSleep(budgets, () => { child.exitCode = 0; }),
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(budgets, [50], '진입 관측은 EXIT_OBSERVE_MS 만 쓴다');
});

test('soft 이후 남은 grace 도중 자식이 끝나면 force 패스를 쏘지 않는다', async () => {
  const calls = [];
  const budgets = [];
  const child = fakeChild();
  await terminateWindowsProcessTree(4321, 250, {
    child,
    run: recordingRun(calls),
    // 1번째 sleep(진입 관측)엔 살아 있고, 2번째(남은 grace)에 종료한다.
    sleep: recordingSleep(budgets, (nth) => { if (nth === 2) child.exitCode = 0; }),
  });
  assert.deepEqual(calls, ['taskkill /PID 4321 /T']);
  // 관측 예산은 grace 에서 떼어 쓴다 — 총 대기는 종전(graceMs)과 같아야 한다.
  assert.deepEqual(budgets, [50, 200]);
  assert.equal(budgets.reduce((a, b) => a + b, 0), 250);
});

test("'exit' 를 구독시켜 주는 핸들은 예산을 다 쓰지 않고 깨어난다", async () => {
  const calls = [];
  const child = fakeEventChild();
  // sleep 은 영원히 안 끝난다 — 그래도 'exit' 로 진행돼야 한다.
  const sleep = () => new Promise(() => {});
  const done = terminateWindowsProcessTree(4321, 250, { child, run: recordingRun(calls), sleep });
  await new Promise(resolve => setImmediate(resolve));
  child.emitExit(0);
  await done;
  assert.deepEqual(calls, [], '진입 관측 중 exit 를 받았으므로 taskkill 은 없다');
  assert.equal(child.listenerCount, 0, "'exit' 리스너를 남기지 않는다");
});

test('grace 를 관측 예산보다 짧게 준 호출부도 총 대기가 grace 를 넘지 않는다', async () => {
  const calls = [];
  const budgets = [];
  await terminateWindowsProcessTree(4321, 20, {
    child: fakeChild(),
    run: recordingRun(calls),
    sleep: recordingSleep(budgets),
  });
  assert.deepEqual(calls, ['taskkill /PID 4321 /T', 'taskkill /PID 4321 /T /F']);
  assert.equal(budgets.reduce((a, b) => a + b, 0), 20, 'grace(20ms) 를 초과 대기하지 않는다');
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
  const budgets = [];
  await terminateWindowsProcessTree(4321, 250, {
    run: recordingRun(calls),
    sleep: recordingSleep(budgets),
  });
  assert.deepEqual(calls, ['taskkill /PID 4321 /T', 'taskkill /PID 4321 /T /F']);
  // 관측할 핸들이 없으면 진입 관측도 없다 — soft 가 곧바로 나가고 grace 한 번만 잔다.
  assert.deepEqual(budgets, [250]);
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
  let parsed = 0;
  let mentions = 0;
  for (const file of tsFiles(libRoot)) {
    if (file.endsWith(join('lib', 'process-tree.ts'))) continue; // 정의 파일
    const source = readFileSync(file, 'utf8');
    // import 절은 이름 뒤에 `(` 가 없어 여기 걸리지 않는다 — 호출만 센다.
    mentions += [...source.matchAll(/terminateDetachedProcessTree\(/g)].length;
    for (const match of source.matchAll(/terminateDetachedProcessTree\(([^;]*?)\)\s*[;.]/gs)) {
      parsed += 1;
      if (!/\bchild\b/.test(match[1])) offenders.push(`${file}: ${match[0].trim()}`);
    }
  }
  assert.deepEqual(offenders, [], `pid 재사용 가드 없이 tree-kill 하는 호출부:\n${offenders.join('\n')}`);

  // 이 검사는 함수 이름을 문자열로 찾으므로 아무것도 못 찾아도 초록으로 끝난다
  // (실측: 세 호출부의 이름을 바꾸면 offenders 가 비어 6/6 통과). 그러면 가드가
  // 사라진 걸 아무도 모르므로 "찾았다"까지 단언한다.
  assert.ok(parsed > 0, 'terminateDetachedProcessTree 호출부를 하나도 못 찾았다 — 함수가 rename 됐거나 호출이 래핑됐다면 이 검사도 새 이름으로 옮겨야 한다');
  // 정규식은 `)` 뒤에 `;` 나 `.` 가 오는 호출만 파싱한다. 파싱 못 한 호출이
  // 남으면 그 호출부는 검사 없이 통과하므로, 개수 불일치 자체를 실패로 본다.
  assert.equal(parsed, mentions, `파싱하지 못한 호출 형태가 있다 (발견 ${mentions} / 검사 ${parsed}) — 위 정규식을 그 형태까지 넓혀야 한다`);
});
