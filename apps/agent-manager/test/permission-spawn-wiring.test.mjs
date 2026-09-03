// 회귀 테스트 — Agent trust 가 **실제로 스폰되는 프로세스의 argv 까지** 도달하는지
// (ticket 5851e435).
//
// 어댑터 단위 테스트(permission-policy-matrix.test.mjs)는 "정책을 주면 argv 가
// 맞다"만 고정한다. 정작 이 티켓의 버그는 그 사이 배선 — spawn 사이트가
// Agent `runtime_config.permission_mode` 를 읽어 어댑터에 넘기는 단계 — 에
// 있었으므로, 여기서는 가짜 `claude` 실행 파일을 delegation.claudeBin 으로
// 물려 진짜 SubagentManager.spawn() / BaseSessionManager 세션 spawn 을 돌리고
// 자식 프로세스가 스스로 기록한 argv 를 단언한다. 배선 한 줄만 빠져도 실패한다.

import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import test, { after } from 'node:test';

import { SubagentManager } from '../dist/lib/subagent-manager.js';
import { BaseSessionManager } from '../dist/lib/base-session-manager.js';

const fixtureRoot = join(process.cwd(), '.test-permission-wiring');
const config = {
  url: 'http://127.0.0.1:0',
  apiKey: 'test-awb-key',
  silentExitVerifyDelayMs: 0,
  delegation: { enabled: true, persistentTicketSessions: false, maxConcurrent: 4, ttlMinutes: 1 },
};

after(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

/** argv 를 캡처 파일에 쓰고 즉시 종료하는 가짜 claude 바이너리. */
async function makeCaptureBin(name) {
  await mkdir(fixtureRoot, { recursive: true });
  const path = join(fixtureRoot, name);
  await writeFile(
    path,
    `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.CAPTURE_FILE, JSON.stringify({ argv: process.argv.slice(2) }));
// 부모가 exit 핸들러를 연결할 시간을 준다(runtime-profiles 픽스처와 동일 이유).
await new Promise((r) => setTimeout(r, 30));
`,
    { mode: 0o755 },
  );
  await chmod(path, 0o755);
  return path;
}

/**
 * 자식이 종료할 때까지 기다린다.
 *
 * `SubagentManager` 는 자식을 POSIX 에서 detached 로 띄우고 곧바로
 * `child.unref()` 한다 — 즉 스폰된 프로세스는 부모의 이벤트 루프를 잡아두지
 * 않는다. 그래서 이 대기 구간에 ref 된 핸들이 하나도 없으면 루프가 그대로
 * 비고, `node --test` 는 파일의 남은 테스트를 전부 `cancelled` 로 처리한다
 * ("Promise resolution is still pending but the event loop has already
 * resolved"). Node 22(CI 버전)에서 실제로 그렇게 됐다 — ubuntu·windows 양쪽
 * 모두. 아래 `setTimeout` 은 ref 된 타이머라 대기 동안 루프를 붙잡는 역할을
 * 겸하며, 동시에 상한을 둬서 배선이 깨졌을 때 조용히 멎지 않고 실패하게 한다.
 */
function waitForExit(manager, tag, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      reject(new Error(`${tag}: 자식 프로세스 종료를 ${timeoutMs}ms 안에 감지하지 못했다`));
    }, timeoutMs);
    manager.onExit = () => {
      clearTimeout(deadline);
      resolve();
    };
  });
}

function makeAgentContext(cwd, permissionMode) {
  return {
    agent_id: 'agent-perm',
    workspace_id: 'ws-perm',
    api_key: 'agent-key',
    cwd,
    mcp_config_path: '',
    cli: 'claude',
    cli_home_dir: cwd,
    model: null,
    extra_env: {},
    credential_provider: null,
    credential_id: null,
    runtime_config: permissionMode
      ? { strategy: 'single', permission_mode: permissionMode }
      : null,
  };
}

/** 한 번의 one-shot spawn 을 끝까지 돌리고 자식이 기록한 argv 를 돌려준다. */
async function captureOneshotArgv({ tag, permissionMode, harness }) {
  const executable = await makeCaptureBin(`claude-${tag}.mjs`);
  const captureFile = join(fixtureRoot, `${tag}.json`);
  const cwd = join(fixtureRoot, `${tag}-home`);
  await mkdir(cwd, { recursive: true });
  const previous = process.env.CAPTURE_FILE;
  process.env.CAPTURE_FILE = captureFile;
  try {
    const manager = new SubagentManager({
      ...config,
      delegation: { ...config.delegation, claudeBin: executable },
    });
    const exited = waitForExit(manager, tag);
    const result = await manager.spawn({
      kind: 'trigger',
      taskText: 'task',
      rolePrompt: 'role',
      triggerId: `trigger-${tag}`,
      ticketId: `ticket-${tag}`,
      agentId: 'agent-perm',
      role: 'assignee',
      agentContext: makeAgentContext(cwd, permissionMode),
      harness,
    });
    assert.equal(result.spawned, true, `${tag}: spawn 실패`);
    await exited;
    return JSON.parse(await readFile(captureFile, 'utf8')).argv;
  } finally {
    if (previous === undefined) delete process.env.CAPTURE_FILE;
    else process.env.CAPTURE_FILE = previous;
  }
}

test('one-shot spawn: trusted Agent 는 harness=plan 을 이기고 실제 argv 에 최고 권한 플래그를 싣는다', async () => {
  const argv = await captureOneshotArgv({
    tag: 'trusted-vs-plan',
    permissionMode: 'trusted',
    harness: { permission_mode: 'plan' },
  });
  assert.ok(
    argv.includes('--dangerously-skip-permissions'),
    `실제 스폰 argv 에 최고 권한 플래그가 없다: ${argv.join(' ')}`,
  );
  assert.equal(
    argv.includes('--permission-mode'),
    false,
    `trusted 인데 대화형 permission 모드로 내려갔다: ${argv.join(' ')}`,
  );
});

test('one-shot spawn: strict Agent 는 harness 가 bypass 를 허용해도 실제 argv 에서 최소 권한으로 내려간다', async () => {
  const argv = await captureOneshotArgv({
    tag: 'strict-vs-bypass',
    permissionMode: 'strict',
    harness: { permission_mode: 'bypassPermissions' },
  });
  const i = argv.indexOf('--permission-mode');
  assert.ok(i >= 0, `strict 인데 --permission-mode 가 없다: ${argv.join(' ')}`);
  assert.equal(argv[i + 1], 'plan');
  assert.equal(
    argv.includes('--dangerously-skip-permissions'),
    false,
    `strict 인데 최고 권한 플래그가 실제 argv 에 남았다: ${argv.join(' ')}`,
  );
});

test('one-shot spawn: Agent trust 미설정(legacy)은 harness 규칙 그대로 실제 argv 에 반영된다', async () => {
  // harness `plan`(= strict 등급)을 쓴다. `acceptEdits`(= approve)는 이제
  // 승인-브리지 게이트에 걸려 스폰 자체가 거부되므로(아래 전용 테스트) argv
  // 배선을 확인하는 용도로는 쓸 수 없다.
  const argv = await captureOneshotArgv({
    tag: 'legacy-harness',
    permissionMode: null,
    harness: { permission_mode: 'plan' },
  });
  const i = argv.indexOf('--permission-mode');
  assert.ok(i >= 0, argv.join(' '));
  assert.equal(argv[i + 1], 'plan');
  assert.equal(argv.includes('--dangerously-skip-permissions'), false);
});

test('one-shot spawn: approve 는 티켓 밖 경로(채팅/Action)에서도 스폰이 거부된다 (리뷰 라운드2 지적 #3)', async () => {
  // event-dispatcher 의 게이트는 pend 할 티켓이 있을 때만 돈다. 채팅/멘션/
  // Action·QA run 처럼 티켓이 없는 경로에서 조용히 실행되면 같은 의미 손실이
  // 남으므로 spawn 사이트에도 같은 게이트를 둔다.
  const executable = await makeCaptureBin('claude-approve.mjs');
  const cwd = join(fixtureRoot, 'approve-home');
  await mkdir(cwd, { recursive: true });
  const manager = new SubagentManager({
    ...config,
    delegation: { ...config.delegation, claudeBin: executable },
  });
  const result = await manager.spawn({
    kind: 'chat',
    taskText: 'task',
    rolePrompt: 'role',
    ticketId: '',
    agentId: 'agent-perm',
    roomId: 'room-approve',
    agentContext: makeAgentContext(cwd, 'approve'),
  });
  assert.equal(result.spawned, false, 'approve 가 승인 없이 스폰됐다');
  assert.equal(result.reason, 'approve_requires_approval_bridge');
  assert.ok(result.detail && result.detail.includes('trusted'), result.detail ?? '(none)');
});

test('persistent 세션 spawn 도 approve 를 거부한다 (리뷰 라운드2 지적 #3)', async () => {
  const executable = await makeCaptureBin('claude-approve-session.mjs');
  const cwd = join(fixtureRoot, 'approve-session-home');
  await mkdir(cwd, { recursive: true });
  const manager = new BaseSessionManager(
    { ...config, delegation: { ...config.delegation, claudeBin: executable } },
    { logTag: '[perm-test]', keyField: 'room_id' },
  );
  try {
    const record = await manager._spawnSession('room-approve', 'role', 'first turn', {
      agentContext: makeAgentContext(cwd, 'approve'),
    });
    assert.equal(record, null, 'approve 세션이 승인 없이 생성됐다');
  } finally {
    await manager?.stopAll?.().catch?.(() => {});
  }
});

test('persistent 세션 spawn 도 같은 배선을 탄다 — trusted Agent 가 harness=acceptEdits 를 이긴다', async () => {
  const executable = await makeCaptureBin('claude-session.mjs');
  const captureFile = join(fixtureRoot, 'session.json');
  const cwd = join(fixtureRoot, 'session-home');
  await mkdir(cwd, { recursive: true });
  const previous = process.env.CAPTURE_FILE;
  process.env.CAPTURE_FILE = captureFile;
  let manager;
  try {
    manager = new BaseSessionManager(
      { ...config, delegation: { ...config.delegation, claudeBin: executable } },
      { logTag: '[perm-test]', keyField: 'room_id' },
    );
    const record = await manager._spawnSession('room-perm', 'role', 'first turn', {
      agentContext: makeAgentContext(cwd, 'trusted'),
      harness: { permission_mode: 'acceptEdits' },
    });
    assert.ok(record, '세션 spawn 이 실패했다');
    // 자식이 캡처 파일을 쓸 때까지 기다린다(가짜 바이너리는 30ms 뒤 종료).
    for (let i = 0; i < 100; i += 1) {
      try {
        const argv = JSON.parse(await readFile(captureFile, 'utf8')).argv;
        assert.ok(
          argv.includes('--dangerously-skip-permissions'),
          `세션 argv 에 최고 권한 플래그가 없다: ${argv.join(' ')}`,
        );
        assert.equal(
          argv.includes('--permission-mode'),
          false,
          `세션이 대화형 permission 모드로 내려갔다: ${argv.join(' ')}`,
        );
        return;
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    assert.fail('세션 자식 프로세스가 argv 를 기록하지 않았다');
  } finally {
    await manager?.stopAll?.().catch?.(() => {});
    if (previous === undefined) delete process.env.CAPTURE_FILE;
    else process.env.CAPTURE_FILE = previous;
  }
});
