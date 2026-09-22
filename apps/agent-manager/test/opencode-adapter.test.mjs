import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OpencodeCliAdapter, OPENCODE_SESSION_ID_RE } from '../dist/lib/cli-adapters/opencode.js';
import {
  ADAPTER_CAPABILITIES,
  describeSpawnArgv,
  selectEffortSlice,
} from '../dist/lib/cli-adapters/base.js';
import { resolveEffectivePermissionPolicy } from '../dist/lib/permission-policy.js';

const tempDirs = [];

async function freshDir(prefix = 'awb-opencode-adapter-') {
  const dir = await fsp.mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

const policy = (trust, harnessMode) => resolveEffectivePermissionPolicy({ trust, harnessMode });

function oneshot(adapter, { permission = null, harness = null, model = null, cwd = null } = {}) {
  return adapter.buildOneshotSpawn({
    rolePrompt: 'role',
    taskText: 'task',
    mcpConfigPath: null,
    model,
    cwd,
    harness,
    permission,
  }).args;
}

test('Opencode declares native MCP without claiming persistent-session support', () => {
  const adapter = new OpencodeCliAdapter();
  assert.equal(OpencodeCliAdapter.cliType, 'opencode');
  assert.equal(adapter.has(ADAPTER_CAPABILITIES.NATIVE_MCP), true);
  assert.equal(adapter.has(ADAPTER_CAPABILITIES.PERSISTENT_SESSION), false);
});

test('resolveBin passes an explicit configured path through', () => {
  const adapter = new OpencodeCliAdapter();
  // normalizeWindowsExecutablePath / win32.normalize applies on Windows, so
  // assert the resolved value, not the literal input spelling.
  const resolved = adapter.resolveBin('/custom/opencode');
  assert.ok(resolved.includes('custom') && resolved.endsWith('opencode'), resolved);
});

test('harnessKeys covers model, permission_mode and system_prompt_append (codex parity)', () => {
  const keys = [...new OpencodeCliAdapter().harnessKeys()];
  assert.ok(keys.includes('model'));
  assert.ok(keys.includes('permission_mode'));
  assert.ok(keys.includes('system_prompt_append'));
});

test('buildOneshotSpawn emits run --format json with message last', () => {
  const args = oneshot(new OpencodeCliAdapter(), {
    permission: policy('trusted'),
    model: 'anthropic/claude-sonnet-4-5',
    cwd: '/tmp/work',
  });
  assert.equal(args[0], 'run');
  assert.deepEqual(args.slice(1, 3), ['--format', 'json']);
  assert.ok(args.includes('--model'));
  assert.equal(args[args.indexOf('--model') + 1], 'anthropic/claude-sonnet-4-5');
  assert.ok(args.includes('--dir'));
  assert.equal(args[args.indexOf('--dir') + 1], '/tmp/work');
  assert.ok(args.includes('--auto'));
  // message (role + task) is the trailing positional.
  assert.ok(String(args[args.length - 1]).includes('task'));
});

test('buildOneshotSpawn omits --auto for approve/strict and folds harness policy text', () => {
  const adapter = new OpencodeCliAdapter();
  assert.equal(oneshot(adapter, { permission: policy('approve') }).includes('--auto'), false);
  assert.equal(oneshot(adapter, { permission: policy('strict') }).includes('--auto'), false);
  const folded = oneshot(adapter, {
    permission: policy('trusted'),
    harness: { system_prompt_append: 'be terse' },
  });
  assert.ok(String(folded[folded.length - 1]).includes('be terse'));
});

test('selectEffortSlice maps opencode to model-only', () => {
  const preset = {
    id: 'x', label: 'X',
    claude: { effort: 'max', ultracode: true, model: 'opus' },
    opencode: { model: 'anthropic/claude-sonnet-4-5' },
  };
  assert.deepEqual(selectEffortSlice('opencode', preset), { model: 'anthropic/claude-sonnet-4-5' });
  assert.equal(selectEffortSlice('opencode', { id: 'y', label: 'Y' }), null);
  assert.equal(selectEffortSlice('opencode', null), null);
});

test('parseStdoutLine classifies opencode JSONL shapes', () => {
  const adapter = new OpencodeCliAdapter();
  const sid = 'ses_abc123';
  assert.equal(adapter.parseStdoutLine(JSON.stringify({ type: 'step_start', sessionID: sid })).stage, 'thinking');
  const toolUse = adapter.parseStdoutLine(JSON.stringify({
    type: 'tool_use', sessionID: sid, part: { tool: 'bash', state: { status: 'completed' } },
  }));
  assert.equal(toolUse.stage, 'composing');
  assert.equal(toolUse.isResult, false);
  const text = adapter.parseStdoutLine(JSON.stringify({
    type: 'text', sessionID: sid, part: { type: 'text', text: 'hello' },
  }));
  assert.equal(text.stage, 'composing');
  const done = adapter.parseStdoutLine(JSON.stringify({
    type: 'step_finish', sessionID: sid, part: { type: 'step-finish', reason: 'stop' },
  }));
  assert.equal(done.isResult, true);
  const cont = adapter.parseStdoutLine(JSON.stringify({
    type: 'step_finish', sessionID: sid, part: { type: 'step-finish', reason: 'tool-calls' },
  }));
  assert.equal(cont.isResult, false);
  const err = adapter.parseStdoutLine(JSON.stringify({
    type: 'error', sessionID: sid, error: { name: 'APIError', data: { message: 'boom' } },
  }));
  assert.equal(err.isError, true);
  const plain = adapter.parseStdoutLine('some prose');
  assert.equal(plain.stage, 'composing');
});

test('parseProgressEvent maps step/tool/error, drops prose and replies', () => {
  const adapter = new OpencodeCliAdapter();
  const start = adapter.parseProgressEvent({ type: 'step_start', sessionID: 'ses_x' });
  assert.deepEqual(start, { kind: 'other', label: '작업', detail: '', status: 'start' });
  const bash = adapter.parseProgressEvent({
    type: 'tool_use', part: { tool: 'bash', state: { status: 'completed', input: { command: 'ls' } } },
  });
  assert.equal(bash.status, 'success');
  assert.equal(bash.kind, 'command');
  assert.equal(bash.detail, 'ls');
  const failed = adapter.parseProgressEvent({
    type: 'tool_use', part: { tool: 'read', state: { status: 'failed', input: { path: 'a' } } },
  });
  assert.equal(failed.status, 'error');
  assert.equal(adapter.parseProgressEvent({ type: 'text', part: { text: 'hi' } }), null);
  assert.equal(
    adapter.parseProgressEvent({
      type: 'tool_use',
      part: { tool: 'awb_send_chat_room_message', state: { status: 'completed', input: {} } },
    }),
    null,
  );
  const err = adapter.parseProgressEvent({
    type: 'error', error: { name: 'APIError', data: { message: 'limit' } },
  });
  assert.equal(err.status, 'error');
  assert.ok(err.detail.includes('limit'));
});

test('extractUsage reads the step_finish ledger, ignores other events', () => {
  const adapter = new OpencodeCliAdapter();
  const snap = adapter.extractUsage({
    type: 'step_finish',
    sessionID: 'ses_x',
    part: {
      type: 'step-finish', reason: 'stop', cost: 0.001,
      tokens: { input: 671, output: 8, reasoning: 0, cache: { read: 21415, write: 0 } },
    },
  });
  assert.deepEqual(snap, {
    input_tokens: 671,
    output_tokens: 8,
    cache_read_input_tokens: 21415,
    cache_creation_input_tokens: 0,
    total_cost_usd: 0.001,
  });
  assert.equal(adapter.extractUsage({ type: 'tool_use', part: {} }), null);
  assert.equal(adapter.extractUsage(null), null);
});

test('collectOneshotResult concatenates text, surfaces errors, falls back to raw', () => {
  const adapter = new OpencodeCliAdapter();
  const lines = [
    JSON.stringify({ type: 'step_start', sessionID: 'ses_x' }),
    JSON.stringify({ type: 'text', part: { text: 'first' } }),
    JSON.stringify({ type: 'tool_use', part: { tool: 'bash', state: { status: 'completed' } } }),
    JSON.stringify({ type: 'text', part: { text: 'second' } }),
  ];
  assert.equal(adapter.collectOneshotResult(lines), 'first\n\nsecond');
  const errLines = [
    JSON.stringify({ type: 'error', error: { name: 'APIError', data: { message: 'Rate limit' } } }),
  ];
  assert.equal(adapter.collectOneshotResult(errLines), '[opencode error] Rate limit');
  assert.equal(adapter.collectOneshotResult([]), null);
});

test('prepareCliHome writes per-agent opencode.json with awb/host MCP and no baked secret', async () => {
  const home = await freshDir();
  const adapter = new OpencodeCliAdapter();
  const { extraEnv } = await adapter.prepareCliHome(home, null, {
    url: 'https://awb.example',
    apiKey: 'per-agent-key-never-baked',
  });
  assert.deepEqual(extraEnv, {});
  const raw = await fsp.readFile(join(home, '.config', 'opencode', 'opencode.json'), 'utf8');
  const config = JSON.parse(raw);
  assert.equal(config.mcp.awb.type, 'remote');
  assert.equal(config.mcp.awb.url, 'https://awb.example/mcp');
  assert.equal(config.mcp.awb.headers.Authorization, 'Bearer {env:AWB_API_KEY}');
  assert.equal(config.mcp.awb.headers['X-AWB-Client-Type'], 'managed-subagent');
  assert.equal(config.mcp.awb.oauth, false);
  assert.ok(!raw.includes('per-agent-key-never-baked'), 'apiKey must not be baked into the file');
  assert.equal(config.mcp.host.type, 'local');
  assert.ok(Array.isArray(config.mcp.host.command));
  assert.ok(config.mcp.host.command.includes('mcp-host'));
});

test('prepareCliHome without an AWB endpoint still provisions the home (operator config preserved)', async () => {
  const home = await freshDir();
  const adapter = new OpencodeCliAdapter();
  await adapter.prepareCliHome(home, null, null);
  const raw = await fsp.readFile(join(home, '.config', 'opencode', 'opencode.json'), 'utf8');
  JSON.parse(raw); // must be valid JSON even with nothing to inject
});

test('buildSessionSpawn gates --session on ses_-shaped ids', () => {
  const adapter = new OpencodeCliAdapter();
  assert.ok(OPENCODE_SESSION_ID_RE.test('ses_abc123'));
  assert.equal(OPENCODE_SESSION_ID_RE.test('room|agent'), false);
  const resume = adapter.buildSessionSpawn({
    rolePrompt: 'role', mcpConfigPath: null,
    sessionMode: 'resume', sessionId: 'ses_abc123',
    permission: policy('trusted'),
  }).args;
  assert.ok(resume.includes('--session'));
  assert.equal(resume[resume.indexOf('--session') + 1], 'ses_abc123');
  // AWB composite keys must start a FRESH session, never fail on a foreign id.
  const fresh = adapter.buildSessionSpawn({
    rolePrompt: 'role', mcpConfigPath: null,
    sessionMode: 'resume', sessionId: 'room|agent',
    permission: policy('trusted'),
  }).args;
  assert.equal(fresh.includes('--session'), false);
  const created = adapter.buildSessionSpawn({
    rolePrompt: 'role', mcpConfigPath: null,
    sessionMode: 'persistent', sessionId: 'room|agent',
    permission: policy('trusted'),
  }).args;
  assert.equal(created.includes('--session'), false);
  assert.equal(created[0], 'run');
});

test('hasPersistedSession rejects non-ses ids without spawning', async () => {
  const adapter = new OpencodeCliAdapter();
  assert.equal(await adapter.hasPersistedSession('/nonexistent', 'room|agent'), false);
  assert.equal(await adapter.hasPersistedSession('/nonexistent', ''), false);
});

test('describeSpawnArgv keeps opencode flags visible and masks values', () => {
  const adapter = new OpencodeCliAdapter();
  const shown = describeSpawnArgv(oneshot(adapter, {
    permission: policy('trusted'),
    model: 'anthropic/claude-sonnet-4-5',
    cwd: '/tmp/work',
  }));
  const tokens = shown.split(' ');
  assert.equal(tokens[0], 'run');
  assert.ok(tokens.includes('--auto'), shown);
  assert.ok(tokens.includes('--format'), shown);
  assert.ok(tokens.includes('json'), shown);
  // free-text values (model id, cwd, prompt) must not leak.
  assert.ok(!shown.includes('anthropic/claude-sonnet-4-5'), shown);
  assert.ok(!shown.includes('/tmp/work'), shown);
  assert.ok(!shown.includes('task'), shown);
});
