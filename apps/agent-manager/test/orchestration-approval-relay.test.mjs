// 미션 실행 승인의 Runtime Host 쪽(docs/orchestration.md "실행 승인").
//
// 멤버 slot 이 `approve` 등급이면 그 CLI 는 권한이 필요한 도구마다 물어야 한다. 매니저가 그 물음을
// AWB 로 올리고(오케스트레이터 또는 사용자가 답한다) 답을 CLI 에 돌려준다. 실패 형태:
//   - 승인 경로가 있는 방인데도 approve 세션을 거부한다(미션이 영영 진행되지 않는다).
//   - 승인 경로가 없는 방에서 approve 세션을 띄운다(조용히 "묻지 않고 거부" 로 바뀐다).
//   - CLI 의 물음에 답하지 않는다 → CLI 가 영원히 멈춘다(모르는 제어 요청 포함).
//   - 답을 기다리는 세션을 idle 리퍼가 죽인다.
// 그래서 가짜 claude 실행 파일로 실제 BaseSessionManager 세션을 띄우고 stdio 왕복을 단언한다.

import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { after } from 'node:test';

import { BaseSessionManager } from '../dist/lib/base-session-manager.js';
import { ClaudeCliAdapter } from '../dist/lib/cli-adapters/claude.js';
import { resolveEffectivePermissionPolicy } from '../dist/lib/permission-policy.js';
import { acpApprovalRelay, createOrchestrationApprovalBridge } from '../dist/lib/orchestration-approval-bridge.js';
import { MANAGER_CAPABILITIES } from '../dist/lib/runtime-profiles.js';

const fixtureRoot = join(process.cwd(), '.test-approval-relay');
const config = {
  url: 'http://awb.test',
  apiKey: 'manager-key',
  silentExitVerifyDelayMs: 0,
  delegation: { enabled: true, persistentTicketSessions: false, maxConcurrent: 4, ttlMinutes: 1 },
};

after(async () => {
  for (let i = 0; i < 25; i += 1) {
    try {
      await rm(fixtureRoot, { recursive: true, force: true });
      return;
    } catch (err) {
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(err?.code) || i === 24) throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
});

function agentContext(cwd, permission_mode) {
  return {
    agent_id: 'rt-0000000000000002',
    account_id: 'ws-1',
    api_key: 'runtime-key',
    cwd,
    mcp_config_path: '',
    cli: 'claude',
    cli_home_dir: cwd,
    model: null,
    extra_env: {},
    credential_provider: null,
    credential_id: null,
    runtime_config: { strategy: 'single', permission_mode },
  };
}

test('this build tells the server it relays mission approvals', () => {
  // 서버는 이 플래그가 없는 호스트에 approve slot 을 보내지 않는다(옛 매니저는 그 실행을 버린다).
  assert.ok(MANAGER_CAPABILITIES.includes('mission_approvals'));
});

// ── Claude stdio protocol (adapter) ──────────────────────────────────────────

test('claude: the stdio prompt flag rides only on approve sessions that asked for it', () => {
  const adapter = new ClaudeCliAdapter();
  const approve = resolveEffectivePermissionPolicy({ trust: 'approve' });
  const trusted = resolveEffectivePermissionPolicy({ trust: 'trusted' });
  const argsOf = (spec) => adapter.buildSessionSpawn({ rolePrompt: '', mcpConfigPath: '/tmp/x.json', ...spec }).args;
  const flagged = argsOf({ permission: approve, permissionPrompt: 'stdio' });
  const i = flagged.indexOf('--permission-prompt-tool');
  assert.ok(i >= 0, flagged.join(' '));
  assert.equal(flagged[i + 1], 'stdio');
  assert.equal(argsOf({ permission: approve }).includes('--permission-prompt-tool'), false);
  // trusted 는 애초에 묻지 않는다(스킵 플래그) — 붙일 이유가 없다.
  assert.equal(argsOf({ permission: trusted, permissionPrompt: 'stdio' }).includes('--permission-prompt-tool'), false);
  assert.equal(adapter.supportsStdioPermissionPrompt(), true);
});

test('claude: a can_use_tool request round-trips into the control_response the CLI expects', () => {
  const adapter = new ClaudeCliAdapter();
  const raw = {
    type: 'control_request',
    request_id: 'req-1',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      input: { command: 'npm test' },
      description: 'run tests',
      permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'localSettings' }],
      tool_use_id: 'toolu_1',
    },
  };
  const prompt = adapter.parsePermissionPrompt(raw);
  assert.equal(prompt.requestId, 'req-1');
  assert.equal(prompt.toolName, 'Bash');
  assert.equal(prompt.interactiveOnly, false);

  const allow = JSON.parse(adapter.formatPermissionAnswer(prompt, { allow: true, rememberForSession: true }));
  assert.equal(allow.type, 'control_response');
  assert.equal(allow.response.subtype, 'success');
  assert.equal(allow.response.request_id, 'req-1');
  assert.equal(allow.response.response.behavior, 'allow');
  assert.deepEqual(allow.response.response.updatedInput, { command: 'npm test' });
  assert.equal(allow.response.response.toolUseID, 'toolu_1');
  // 기억은 세션에만 — 저장소의 .claude/settings.local.json 을 건드리지 않는다.
  assert.deepEqual(allow.response.response.updatedPermissions.map((p) => p.destination), ['session']);

  const once = JSON.parse(adapter.formatPermissionAnswer(prompt, { allow: true }));
  assert.equal(once.response.response.updatedPermissions, undefined);

  const deny = JSON.parse(adapter.formatPermissionAnswer(prompt, { allow: false, message: 'not in scope' }));
  assert.equal(deny.response.response.behavior, 'deny');
  assert.equal(deny.response.response.message, 'not in scope');

  assert.equal(adapter.parsePermissionPromptCancel({ type: 'control_cancel_request', request_id: 'req-1' }), 'req-1');
  const ask = adapter.parsePermissionPrompt({ type: 'control_request', request_id: 'q', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: {} } });
  assert.equal(ask.interactiveOnly, true, 'nobody sits at an AWB-run CLI to answer AskUserQuestion');
  const reject = JSON.parse(adapter.rejectUnsupportedControlRequest({ type: 'control_request', request_id: 'e', request: { subtype: 'elicitation' } }));
  assert.equal(reject.response.subtype, 'error');
  assert.equal(reject.response.request_id, 'e');
  assert.equal(adapter.rejectUnsupportedControlRequest(raw), null, 'a permission prompt is answered, not rejected');
});

// ── BaseSessionManager wiring (real spawn, fake claude) ──────────────────────

async function makeFakeClaude(name) {
  await mkdir(fixtureRoot, { recursive: true });
  const path = join(fixtureRoot, name);
  await writeFile(
    path,
    `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const out = { argv: process.argv.slice(2), responses: [] };
const rl = createInterface({ input: process.stdin });
let asked = false;
rl.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.type === 'user' && !asked) {
    asked = true;
    process.stdout.write(JSON.stringify({ type: 'control_request', request_id: 'req-123', request: {
      subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'npm test' }, description: 'run tests',
      permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'localSettings' }],
      tool_use_id: 'toolu_1' } }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'control_request', request_id: 'req-other', request: { subtype: 'elicitation' } }) + '\\n');
  } else if (m.type === 'control_response') {
    out.responses.push(m);
    if (out.responses.length >= 2) {
      writeFileSync(process.env.CAPTURE_FILE, JSON.stringify(out));
      process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }) + '\\n');
      setTimeout(() => process.exit(0), 30);
    }
  }
});
`,
    { mode: 0o755 },
  );
  await chmod(path, 0o755);
  return path;
}

async function readCapture(file) {
  for (let i = 0; i < 250; i += 1) {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      if (err?.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  throw new Error('the fake CLI never recorded its answers');
}

function waitForChildExit(child, timeoutMs = 15_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('session child did not exit')), timeoutMs);
    child.once('exit', () => { clearTimeout(deadline); resolve(); });
  });
}

test('an approve session in a mission room relays the prompt and writes the answer back', async () => {
  const executable = await makeFakeClaude('claude-relay.mjs');
  const captureFile = join(fixtureRoot, 'relay.json');
  const cwd = join(fixtureRoot, 'relay-home');
  await mkdir(cwd, { recursive: true });
  const previous = process.env.CAPTURE_FILE;
  process.env.CAPTURE_FILE = captureFile;
  const asked = [];
  const bridge = {
    async request(prompt) {
      asked.push(prompt);
      return { decision: 'allow_session', message: 'Approved by the mission orchestrator.' };
    },
  };
  const manager = new BaseSessionManager(
    { ...config, delegation: { ...config.delegation, claudeBin: executable } },
    { logTag: '[approval-test]', keyField: 'room_id' },
  );
  let child = null;
  try {
    const record = await manager._spawnSession('room-step', 'role', 'do the step', {
      agentContext: agentContext(cwd, 'approve'),
      approvalBridge: bridge,
    });
    assert.ok(record, 'an approve session with an approval route must spawn');
    child = record.child;
    const captured = await readCapture(captureFile);
    assert.ok(captured.argv.includes('--permission-prompt-tool'), captured.argv.join(' '));
    assert.equal(asked.length, 1);
    assert.equal(asked[0].requestKey, 'req-123');
    assert.equal(asked[0].toolName, 'Bash');
    assert.equal(asked[0].canAllowSession, true);
    const byId = new Map(captured.responses.map((r) => [r.response.request_id, r.response]));
    assert.equal(byId.get('req-123').response.behavior, 'allow');
    assert.deepEqual(byId.get('req-123').response.updatedPermissions.map((p) => p.destination), ['session']);
    assert.equal(byId.get('req-other').subtype, 'error', 'an unknown control request is refused instead of left hanging');
  } finally {
    await manager.stopAll?.().catch?.(() => {});
    await waitForChildExit(child);
    if (previous === undefined) delete process.env.CAPTURE_FILE;
    else process.env.CAPTURE_FILE = previous;
  }
});

test('without an approval route the approve session is still refused', async () => {
  const executable = await makeFakeClaude('claude-no-route.mjs');
  const cwd = join(fixtureRoot, 'no-route-home');
  await mkdir(cwd, { recursive: true });
  const manager = new BaseSessionManager(
    { ...config, delegation: { ...config.delegation, claudeBin: executable } },
    { logTag: '[approval-test]', keyField: 'room_id' },
  );
  try {
    const record = await manager._spawnSession('room-chat', 'role', 'hi', { agentContext: agentContext(cwd, 'approve') });
    assert.equal(record, null);
  } finally {
    await manager.stopAll?.().catch?.(() => {});
  }
});

test('the idle reaper leaves a session alone while it waits on an answer', async () => {
  const manager = new BaseSessionManager(config, { logTag: '[approval-test]', keyField: 'room_id' });
  let ended = false;
  const sess = {
    room_id: 'room-idle',
    pid: 999999,
    child: { stdin: { end() { ended = true; } } },
    idleTimer: null,
    _pendingApprovals: new Map([['req', new AbortController()]]),
  };
  // 등록만 한다(stdio 배선 없이) — 이 테스트는 리퍼의 판정만 본다.
  manager._sessions.set('room-idle', sess);
  try {
    await manager._onIdleTimerFired(sess, 1_000);
    assert.equal(ended, false, 'a CLI blocked on an approval must not be closed for being quiet');
    assert.ok(sess.idleTimer, 'it is re-checked later instead');
    await manager._maybeKillUnhealthy(sess, 'test');
    assert.equal(sess.unhealthyKilled, undefined);
  } finally {
    if (sess.idleTimer) clearTimeout(sess.idleTimer);
  }
});

// ── Bridge (HTTP) ───────────────────────────────────────────────────────────

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    const call = { url: String(url), method: init.method, key: init.headers['X-Agent-Key'], body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const { status = 200, body = {} } = await handler(call, calls);
    return { ok: status >= 200 && status < 300, status, async json() { return body; } };
  };
  return { impl, calls };
}

test('bridge: posts the prompt, long-polls until answered, falls back to the manager key', async () => {
  let polls = 0;
  const { impl, calls } = fakeFetch((call) => {
    if (call.method === 'POST' && call.key === 'runtime-key') return { status: 401, body: { error: 'stale' } };
    if (call.method === 'POST') return { status: 201, body: { id: 'appr-1', status: 'pending', route: 'orchestrator', decision: null, message: '' } };
    polls += 1;
    return polls < 3
      ? { body: { id: 'appr-1', status: 'pending', route: 'orchestrator', decision: null, message: '' } }
      : { body: { id: 'appr-1', status: 'approved', route: 'orchestrator', decision: 'allow', message: 'Approved by the mission orchestrator.' } };
  });
  const bridge = createOrchestrationApprovalBridge(config, {
    roomId: 'room-1', agentId: 'rt-x', apiKey: 'runtime-key', fetchImpl: impl, pollTimeoutMs: 10, sleep: async () => {},
  });
  const outcome = await bridge.request({ requestKey: 'req-9', toolName: 'Bash', input: { command: 'ls' }, canAllowSession: false });
  assert.deepEqual(outcome, { decision: 'allow', message: 'Approved by the mission orchestrator.' });
  const post = calls.find((c) => c.method === 'POST' && c.key === 'manager-key');
  assert.equal(post.url, 'http://awb.test/api/agent/orchestration/approvals');
  assert.deepEqual(
    { room_id: post.body.room_id, agent_id: post.body.agent_id, request_key: post.body.request_key, tool_name: post.body.tool_name },
    { room_id: 'room-1', agent_id: 'rt-x', request_key: 'req-9', tool_name: 'Bash' },
  );
  assert.ok(calls.filter((c) => c.method === 'GET').every((c) => c.url.includes('/approvals/appr-1/wait?agent_id=rt-x')));
});

test('bridge: an answer it cannot get is a denial, never an approval', async () => {
  const { impl } = fakeFetch((call) =>
    call.method === 'POST'
      ? { status: 201, body: { id: 'appr-2', status: 'pending', route: 'user', decision: null, message: '' } }
      : { status: 404, body: { error: 'approval not found' } });
  const bridge = createOrchestrationApprovalBridge(config, { roomId: 'r', agentId: 'rt-x', fetchImpl: impl, pollTimeoutMs: 10, sleep: async () => {} });
  const outcome = await bridge.request({ requestKey: 'k', toolName: 'Edit', canAllowSession: false });
  assert.equal(outcome.decision, 'deny');
  assert.match(outcome.message, /approval not found/);
});

test('bridge: when the CLI withdraws the prompt the request is cancelled on AWB', async () => {
  const controller = new AbortController();
  const { impl, calls } = fakeFetch(async (call) => {
    if (call.method === 'POST' && call.url.endsWith('/cancel')) return { body: { id: 'appr-3', status: 'cancelled', decision: null, message: '' } };
    if (call.method === 'POST') return { status: 201, body: { id: 'appr-3', status: 'pending', route: 'user', decision: null, message: '' } };
    controller.abort();
    return { body: { id: 'appr-3', status: 'pending', route: 'user', decision: null, message: '' } };
  });
  const bridge = createOrchestrationApprovalBridge(config, { roomId: 'r', agentId: 'rt-x', fetchImpl: impl, pollTimeoutMs: 10, sleep: async () => {} });
  await assert.rejects(() => bridge.request({ requestKey: 'k3', toolName: 'Bash', canAllowSession: false }, controller.signal), /abort/i);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(calls.some((c) => c.url.endsWith('/approvals/appr-3/cancel')), 'the withdrawn request must not linger as something the user can approve');
});

test('ACP relay (Hermes) picks the option that matches the answer', async () => {
  const options = [
    { optionId: 'o1', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'o2', name: 'Always', kind: 'allow_always' },
    { optionId: 'o3', name: 'Reject', kind: 'reject_once' },
  ];
  const answer = (decision) => acpApprovalRelay({ async request() { return { decision, message: '' }; } });
  const request = { sessionId: 's', toolCall: { toolCallId: 'tc1', title: 'Run', kind: 'execute' }, options };
  assert.deepEqual(await answer('allow')({ runId: 'run' }, request), { outcome: 'selected', optionId: 'o1' });
  assert.deepEqual(await answer('allow_session')({ runId: 'run' }, request), { outcome: 'selected', optionId: 'o2' });
  assert.deepEqual(await answer('deny')({ runId: 'run' }, request), { outcome: 'selected', optionId: 'o3' });
  assert.deepEqual(await answer('deny')({ runId: 'run' }, { ...request, options: options.slice(0, 2) }), { outcome: 'cancelled' });
});
