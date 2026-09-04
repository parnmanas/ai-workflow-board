// 회귀 테스트 — 실제 spawn 사양 기록의 **생산 경로** 계약 (ticket 20fff298 리뷰 3R).
//
// 단위 테스트(launch-spec-recorder.test.mjs)는 "입력을 주면 기록이 맞다"만
// 고정한다. 리뷰 3R 이 잡은 두 결함은 정작 그 사이 배선에 있었다:
//
//   1. persistent 세션 경로가 `recordActualLaunch()` 를 **pid 확인보다 먼저**
//      호출해, pid 없이 돌아온 spawn 실패가 직전의 정상 기록을 덮어썼다 —
//      화면이 실행되지 않은 argv/cwd/env 를 ground truth 라고 주장했다.
//   2. 실제 argv 의 인자별 출처가 전부 `unattributed` 였다.
//
// 그래서 여기서는 진짜 `BaseSessionManager._spawnSession()` 을 돌린다. 1번은
// `spawnProcess` 만 pid 없는 자식으로 바꿔치기해 실제 실패 분기를 타고, 2번은
// 가짜 `claude` 실행 파일로 실제 spawn 을 끝까지 돌려 기록을 읽는다.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { after } from 'node:test';

import { BaseSessionManager } from '../dist/lib/base-session-manager.js';
import { SubagentManager } from '../dist/lib/subagent-manager.js';
import { createRuntimeAdapterResolver } from '../dist/lib/runtime/runtime-registry.js';
import {
  lastActualLaunch,
  _resetRecordedLaunches,
} from '../dist/lib/launch-spec-recorder.js';

const AGENT_ID = 'agent-record-on-spawn';
const fixtureRoot = join(process.cwd(), '.test-launch-spec-record');
const config = {
  url: 'http://127.0.0.1:0',
  apiKey: 'test-awb-key',
  silentExitVerifyDelayMs: 0,
  delegation: { enabled: true, persistentTicketSessions: true, maxConcurrent: 4, ttlMinutes: 1 },
};

/** 픽스처 정리 — Windows 의 핸들 해제 지연을 흡수한다(permission-spawn-wiring 과 동일 사유). */
after(async () => {
  for (let i = 1; ; i += 1) {
    try {
      await rm(fixtureRoot, { recursive: true, force: true });
      return;
    } catch (err) {
      const transient = err?.code === 'EBUSY' || err?.code === 'EPERM' || err?.code === 'ENOTEMPTY';
      if (!transient || i >= 25) throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
});

/** 즉시 종료하는 가짜 `claude`. argv 는 기록 쪽에서 읽으므로 캡처하지 않는다. */
async function makeBin(name) {
  await mkdir(fixtureRoot, { recursive: true });
  const path = join(fixtureRoot, name);
  await writeFile(
    path,
    `#!/usr/bin/env node
// 부모가 exit 핸들러를 붙일 시간을 준다(다른 spawn 픽스처와 같은 이유).
await new Promise((r) => setTimeout(r, 30));
`,
    { mode: 0o755 },
  );
  await chmod(path, 0o755);
  return path;
}

function makeAgentContext(cwd) {
  return {
    agent_id: AGENT_ID,
    workspace_id: 'ws-record',
    api_key: 'agent-key',
    cwd,
    mcp_config_path: '',
    cli: 'claude',
    cli_home_dir: cwd,
    model: 'claude-opus-5',
    extra_env: {},
    credential_provider: null,
    credential_id: null,
    runtime_config: { strategy: 'single', permission_mode: 'trusted' },
  };
}

function makeManager(executable, adapterResolver) {
  return new BaseSessionManager(
    { ...config, delegation: { ...config.delegation, claudeBin: executable } },
    { logTag: '[record-test]', keyField: 'room_id', ...(adapterResolver ? { adapterResolver } : {}) },
  );
}

/** 자식 종료를 실제로 기다린다 — 픽스처 안이 cwd 라 살아 있으면 Windows 정리가 EBUSY 난다. */
function waitForChildExit(child, tag, timeoutMs = 15_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      reject(new Error(`${tag}: 세션 자식 종료를 ${timeoutMs}ms 안에 감지하지 못했다`));
    }, timeoutMs);
    child.once('exit', () => {
      clearTimeout(deadline);
      resolve();
    });
  });
}

/**
 * `spawnProcess` 만 **pid 없는 자식**으로 바꾼 resolver.
 *
 * 나머지 메서드는 실제 resolver 에 그대로 위임한다 — 어댑터 빌드·재시도 판정을
 * 흉내내면 정작 검증하려는 생산 경로가 아니게 된다. pid 확인 직전까지 도는
 * 코드는 `once('error')` 와 `unref()` 뿐이라 그만 갖춘 최소 stub 으로 충분하다.
 */
function makePidlessResolver() {
  const real = createRuntimeAdapterResolver();
  const calls = [];
  const stub = {
    ports: real.ports,
    resolve: (...a) => real.resolve(...a),
    buildOneshot: (...a) => real.buildOneshot(...a),
    buildSession: (...a) => real.buildSession(...a),
    shouldRetry: (...a) => real.shouldRetry(...a),
    spawnProcess: (command, args, options) => {
      calls.push({ command, args: [...args], options });
      const child = new EventEmitter();
      child.pid = undefined;
      child.unref = () => {};
      return child;
    },
  };
  return { stub, calls };
}

test('성공한 persistent 세션 spawn 은 실제 argv 에 인자별 출처를 붙여 기록한다', async () => {
  _resetRecordedLaunches();
  const executable = await makeBin('claude-ok.mjs');
  const cwd = join(fixtureRoot, 'ok-home');
  await mkdir(cwd, { recursive: true });
  const manager = makeManager(executable);
  let child = null;
  try {
    const record = await manager._spawnSession('room-ok', 'role prompt', 'first turn', {
      agentContext: makeAgentContext(cwd),
      harness: { disallowed_tools: ['WebFetch'] },
      monitorMeta: { ticket_id: 'ticket-ok', role: 'assignee' },
    });
    assert.ok(record, '세션 spawn 이 실패했다');
    child = record.child ?? null;

    const recorded = lastActualLaunch(AGENT_ID);
    assert.ok(recorded, '성공한 spawn 이 기록되지 않았다');
    assert.equal(recorded.mode, 'session');
    assert.equal(recorded.bin, executable);
    assert.equal(recorded.cwd, cwd);

    // 리뷰 3R 의 핵심 — 실제 argv 에 출처가 붙는다.
    assert.equal(recorded.args_attributed, true, '실제 argv 의 출처 귀속이 실패했다');
    const sources = new Set(recorded.args.map((a) => a.source));
    assert.equal(sources.has('unattributed'), false, `귀속되지 않은 토큰이 남았다: ${JSON.stringify(recorded.args)}`);
    // 에이전트 모델과 trust 등급이 각자 자기 토큰을 가져간다.
    assert.deepEqual(
      recorded.args.filter((a) => a.source === 'model').map((a) => a.value),
      ['--model', 'claude-opus-5'],
    );
    assert.deepEqual(
      recorded.args.filter((a) => a.source === 'permission').map((a) => a.value),
      ['--dangerously-skip-permissions'],
    );
    // **디스패치 시점 입력**인 harness 도 실제 토큰에 귀속된다 — 추정에는 없다.
    assert.ok(
      recorded.args.some((a) => a.source === 'harness' && a.value === '--disallowedTools'),
      `harness 가 만든 인자가 귀속되지 않았다: ${JSON.stringify(recorded.args)}`,
    );
    // 세션 식별자도 실제 값으로 귀속된다(추정에서는 자리표시자였다).
    assert.ok(
      recorded.args.some((a) => a.source === 'session'),
      `세션 식별자가 귀속되지 않았다: ${JSON.stringify(recorded.args)}`,
    );
    // 프롬프트 본문은 어느 경로로도 기록에 오르지 않는다.
    assert.equal(JSON.stringify(recorded).includes('role prompt'), false, '프롬프트 본문이 기록에 실렸다');
  } finally {
    await manager?.stopAll?.().catch?.(() => {});
    await waitForChildExit(child, 'ok-home');
  }
});

test('pid 없이 돌아온 persistent spawn 은 기록을 만들지 않는다', async () => {
  _resetRecordedLaunches();
  const executable = await makeBin('claude-nopid.mjs');
  const cwd = join(fixtureRoot, 'nopid-home');
  await mkdir(cwd, { recursive: true });
  const { stub, calls } = makePidlessResolver();
  const manager = makeManager(executable, stub);
  try {
    const record = await manager._spawnSession('room-nopid', 'role prompt', 'first turn', {
      agentContext: makeAgentContext(cwd),
    });
    assert.equal(record, null, 'pid 없는 spawn 이 세션 레코드를 만들었다');
    // 가드가 spawn **뒤**에 있다는 사실을 고정한다 — spawn 자체에 도달하지
    // 못했다면 이 테스트는 공허하다.
    assert.equal(calls.length, 1, 'spawn 에 도달하지 못했다 (테스트가 공허해진다)');
    assert.equal(
      lastActualLaunch(AGENT_ID),
      null,
      '실행되지 않은 spawn 이 ground truth 로 기록됐다',
    );
  } finally {
    await manager?.stopAll?.().catch?.(() => {});
  }
});

test('pid 없이 돌아온 persistent spawn 은 직전 정상 기록을 덮지 않는다', async () => {
  _resetRecordedLaunches();
  const executable = await makeBin('claude-keep.mjs');
  const goodCwd = join(fixtureRoot, 'keep-good-home');
  const badCwd = join(fixtureRoot, 'keep-bad-home');
  await mkdir(goodCwd, { recursive: true });
  await mkdir(badCwd, { recursive: true });

  const good = makeManager(executable);
  let child = null;
  let before;
  try {
    const record = await good._spawnSession('room-keep', 'good role', 'first turn', {
      agentContext: makeAgentContext(goodCwd),
      monitorMeta: { ticket_id: 'ticket-good', role: 'assignee' },
    });
    assert.ok(record, '기준이 될 정상 spawn 이 실패했다');
    child = record.child ?? null;
    before = lastActualLaunch(AGENT_ID);
    assert.ok(before, '정상 spawn 이 기록되지 않았다');
    assert.equal(before.cwd, goodCwd);
  } finally {
    await good?.stopAll?.().catch?.(() => {});
    await waitForChildExit(child, 'keep-good-home');
  }

  // 같은 에이전트의 두 번째 spawn 이 pid 없이 실패한다. cwd·역할을 다르게 줘서
  // 덮어쓰기가 일어나면 값으로 드러나게 한다.
  const { stub, calls } = makePidlessResolver();
  const bad = makeManager(executable, stub);
  try {
    const record = await bad._spawnSession('room-keep-2', 'bad role', 'first turn', {
      agentContext: makeAgentContext(badCwd),
      monitorMeta: { ticket_id: 'ticket-bad', role: 'reviewer' },
    });
    assert.equal(record, null, 'pid 없는 spawn 이 세션 레코드를 만들었다');
    assert.equal(calls.length, 1, 'spawn 에 도달하지 못했다 (테스트가 공허해진다)');
  } finally {
    await bad?.stopAll?.().catch?.(() => {});
  }

  const after_ = lastActualLaunch(AGENT_ID);
  assert.deepEqual(after_, before, '실패한 spawn 이 직전 정상 기록을 덮어썼다');
  assert.equal(after_.cwd, goodCwd, 'cwd 가 실행되지 않은 spawn 의 값으로 바뀌었다');
  assert.equal(after_.context.role, 'assignee', '문맥이 실행되지 않은 spawn 의 값으로 바뀌었다');
});

test('one-shot spawn 도 실제 argv 에 인자별 출처를 붙여 기록한다', async () => {
  // 이 티켓이 oneshot spawn 사이트의 spec 조립을 리터럴 두 벌에서 변수 하나로
  // 바꿨다(귀속 입력을 넘기기 위해). 그 리팩터가 실제 argv 를 바꾸지 않았고
  // 출처 귀속이 붙는다는 것을 생산 경로에서 함께 고정한다.
  _resetRecordedLaunches();
  const executable = await makeBin('claude-oneshot.mjs');
  const cwd = join(fixtureRoot, 'oneshot-home');
  await mkdir(cwd, { recursive: true });
  const manager = new SubagentManager({
    ...config,
    delegation: { ...config.delegation, persistentTicketSessions: false, claudeBin: executable },
  });
  // 자식은 detached + unref 라 이벤트 루프를 잡지 않는다 — ref 된 타이머로
  // 대기 구간을 붙잡고 상한도 함께 둔다(permission-spawn-wiring 과 같은 이유).
  const exited = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('one-shot 자식 종료를 감지하지 못했다')), 15_000);
    manager.onExit = () => { clearTimeout(deadline); resolve(); };
  });
  const result = await manager.spawn({
    kind: 'trigger',
    taskText: 'task body',
    rolePrompt: 'role prompt',
    triggerId: 'trigger-oneshot',
    ticketId: 'ticket-oneshot',
    agentId: AGENT_ID,
    role: 'assignee',
    agentContext: makeAgentContext(cwd),
    harness: { disallowed_tools: ['WebFetch'] },
  });
  assert.equal(result.spawned, true, `one-shot spawn 실패: ${result.reason ?? ''}`);
  await exited;

  const recorded = lastActualLaunch(AGENT_ID);
  assert.ok(recorded, 'one-shot spawn 이 기록되지 않았다');
  assert.equal(recorded.mode, 'oneshot');
  assert.equal(recorded.args_attributed, true, 'one-shot 실제 argv 의 출처 귀속이 실패했다');
  assert.equal(
    recorded.args.some((a) => a.source === 'unattributed'), false,
    `귀속되지 않은 토큰이 남았다: ${JSON.stringify(recorded.args)}`,
  );
  assert.ok(
    recorded.args.some((a) => a.source === 'harness' && a.value === '--disallowedTools'),
    `harness 가 만든 인자가 귀속되지 않았다: ${JSON.stringify(recorded.args)}`,
  );
  // oneshot 만의 골격 — `--print` 가 붙고 task text 가 positional 로 들어간다.
  const values = recorded.args.map((a) => a.value);
  assert.ok(values.includes('--print'), `one-shot argv 가 아니다: ${values.join(' ')}`);
  const blob = JSON.stringify(recorded);
  assert.equal(blob.includes('task body'), false, 'task text 원문이 기록에 실렸다');
  assert.equal(blob.includes('role prompt'), false, '프롬프트 본문이 기록에 실렸다');
});
