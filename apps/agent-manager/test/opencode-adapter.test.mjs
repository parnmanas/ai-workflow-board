import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OpencodeCliAdapter, OPENCODE_SESSION_ID_RE } from '../dist/lib/cli-adapters/opencode.js';
import {
  ADAPTER_CAPABILITIES,
  describeSpawnArgv,
} from '../dist/lib/cli-adapters/base.js';
import { selectEffortSlice } from '../dist/lib/clis/effort.js';
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

test('buildOneshotSpawn emits run --format json, and the prompt goes over STDIN — never argv', () => {
  const adapter = new OpencodeCliAdapter();
  const d = adapter.buildOneshotSpawn({
    rolePrompt: 'You are a careful engineer.',
    taskText: 'task: do the thing',
    permission: policy('trusted'),
    model: 'anthropic/claude-sonnet-4-5',
    cwd: '/tmp/work',
    harness: null,
  });
  const args = d.args;
  assert.equal(args[0], 'run');
  assert.deepEqual(args.slice(1, 3), ['--format', 'json']);
  assert.ok(args.includes('--model'));
  assert.equal(args[args.indexOf('--model') + 1], 'anthropic/claude-sonnet-4-5');
  assert.ok(args.includes('--dir'));
  assert.equal(args[args.indexOf('--dir') + 1], '/tmp/work');
  assert.ok(args.includes('--auto'));

  // Windows regression (live incident): the `[message..]` positional carried
  // the whole work order (~8 KB). The npm `.cmd` shim runs through
  // `cmd.exe /d /s /c`, whose command line is capped at 8191 chars, so any
  // real work order made cmd.exe refuse to start the child — exit 1 in 0 s,
  // no stdout — and the step silently waited for the lease reaper. The
  // prompt must therefore never be an argv element; it rides stdin instead.
  assert.ok(!args.some((a) => /task: do the thing|careful engineer/.test(String(a))),
    'the prompt must not appear anywhere in argv');
  assert.equal(d.stdio[0], 'pipe', 'stdin must be a pipe so writePrompt can feed the prompt');
  assert.equal(typeof d.writePrompt, 'function', 'the descriptor must supply writePrompt (codex precedent)');

  let written = '';
  let ended = false;
  d.writePrompt({ stdin: { write: (s) => { written += s; }, end: () => { ended = true; } } });
  assert.match(written, /careful engineer/);
  assert.match(written, /task: do the thing/);
  assert.ok(ended, 'stdin must be closed after the prompt, or opencode waits forever for more input');
});

test('buildOneshotSpawn keeps every argv element short of the Windows cmd.exe limit regardless of prompt size', () => {
  const huge = 'x'.repeat(20_000);
  const d = new OpencodeCliAdapter().buildOneshotSpawn({
    rolePrompt: huge,
    taskText: huge,
    permission: policy('trusted'),
    model: 'opencode/muse-spark-1.3-contributor-free',
    cwd: 'E:\\Repository\\txiv\\emberdelve',
    harness: { system_prompt_append: huge },
  });
  const total = d.args.reduce((n, a) => n + String(a).length + 1, 0);
  assert.ok(total < 2000,
    `argv must stay tiny (got ${total} chars) — cmd.exe caps the whole command line at 8191 and the prompt alone exceeded it`);
  let written = '';
  d.writePrompt({ stdin: { write: (s) => { written += s; }, end: () => {} } });
  assert.ok(written.length >= 60_000, 'the full prompt still reaches the CLI, via stdin');
});

test('buildOneshotSpawn omits --auto for approve/strict and folds harness policy text', () => {
  const adapter = new OpencodeCliAdapter();
  assert.equal(oneshot(adapter, { permission: policy('approve') }).includes('--auto'), false);
  assert.equal(oneshot(adapter, { permission: policy('strict') }).includes('--auto'), false);
  // The harness policy is folded into the PROMPT, which now rides stdin
  // (never argv — see the Windows cmd.exe limit test above), so read it back
  // through writePrompt rather than from the last argv element.
  const d = adapter.buildOneshotSpawn({
    rolePrompt: 'role',
    taskText: 'task',
    mcpConfigPath: null,
    model: null,
    cwd: null,
    permission: policy('trusted'),
    harness: { system_prompt_append: 'be terse' },
  });
  let written = '';
  d.writePrompt({ stdin: { write: (s) => { written += s; }, end: () => {} } });
  assert.match(written, /AWB managed policy:\nbe terse\nEnd AWB managed policy\./);
  assert.ok(!d.args.some((a) => String(a).includes('be terse')), 'policy text must not leak into argv');
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
  // Windows regression (EmberDelve, 2026-09-25): opencode resolves its config
  // dir via xdg-basedir — $XDG_CONFIG_HOME, else os.homedir()/.config — and on
  // Windows os.homedir() is USERPROFILE, which the manager's HOME redirect never
  // touches. Without this env the per-agent file below is written and never
  // read: the child loads the operator's config, has no `awb` server, and every
  // step ends without a report. Pin it explicitly, on every platform.
  assert.deepEqual(extraEnv, { XDG_CONFIG_HOME: join(home, '.config') });
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

test('prepareCliHome merges the operator opencode.jsonc (comments, trailing commas, // inside URLs)', async () => {
  // Operators who set opencode up interactively have ONLY `opencode.jsonc` —
  // that is what the CLI writes — and both fleet hosts carry their ComfyUI MCP
  // server there. Reading just `.json` dropped it from every agent's config.
  const fakeOperatorHome = await freshDir('awb-opencode-operator-');
  const operatorConfigDir = join(fakeOperatorHome, '.config', 'opencode');
  await fsp.mkdir(operatorConfigDir, { recursive: true });
  await fsp.writeFile(
    join(operatorConfigDir, 'opencode.jsonc'),
    [
      '{',
      '  "$schema": "https://opencode.ai/config.json", // schema for editors',
      '  /* operator servers */',
      '  "mcp": {',
      '    "comfyui-txiv": { "type": "local", "command": ["npx", "-y", "comfyui-mcp"], "environment": { "COMFYUI_URL": "https://txiv-comfyui.example" }, },',
      '  },',
      '}',
    ].join('\n'),
  );
  await fsp.writeFile(
    join(operatorConfigDir, 'opencode.json'),
    JSON.stringify({ mcp: { legacy: { type: 'local', command: ['legacy-mcp'] } }, theme: 'dark' }),
  );
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  process.env.HOME = fakeOperatorHome;
  process.env.USERPROFILE = fakeOperatorHome;
  try {
    const home = await freshDir();
    const adapter = new OpencodeCliAdapter();
    await adapter.prepareCliHome(home, null, { url: 'https://awb.example', apiKey: 'k' });
    const config = JSON.parse(await fsp.readFile(join(home, '.config', 'opencode', 'opencode.json'), 'utf8'));
    assert.equal(config.$schema, 'https://opencode.ai/config.json');
    assert.equal(config.theme, 'dark', '.json keys survive the .jsonc merge');
    assert.deepEqual(Object.keys(config.mcp).sort(), ['awb', 'comfyui-txiv', 'host', 'legacy']);
    assert.equal(config.mcp['comfyui-txiv'].environment.COMFYUI_URL, 'https://txiv-comfyui.example',
      'a // inside a string must not be treated as a comment');
    assert.equal(config.mcp.awb.url, 'https://awb.example/mcp');
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
  }
});

test('the run message opens with the awb_<tool> naming note, ahead of the role prompt', () => {
  // The Windows member concluded "report tool이 이 세션에 노출되지 않아" because the
  // work order said mcp__awb__report_orchestration_step and opencode lists it
  // as awb_report_orchestration_step. The note must precede any instruction
  // that uses the other spelling.
  const adapter = new OpencodeCliAdapter();
  const d = adapter.buildOneshotSpawn({
    rolePrompt: 'ROLE PROMPT — call mcp__awb__report_orchestration_step when done.',
    taskText: 'TASK',
    permission: policy('trusted'),
    model: null,
    cwd: null,
    harness: { system_prompt_append: 'POLICY' },
  });
  let written = '';
  d.writePrompt({ stdin: { write: (s) => { written += s; }, end: () => {} } });
  const note = written.indexOf('awb_report_orchestration_step');
  const policyAt = written.indexOf('AWB managed policy');
  const role = written.indexOf('ROLE PROMPT');
  assert.ok(note >= 0, 'naming note present');
  assert.ok(note < policyAt && policyAt < role, 'note first, then managed policy, then the role prompt');
  assert.match(written, /mcp__awb__<tool>.*awb_<tool>/s);
});

test('extractAssistantText returns opencode text parts only', () => {
  const adapter = new OpencodeCliAdapter();
  assert.equal(adapter.extractAssistantText({ type: 'text', part: { text: '  최종 보고  ' } }), '최종 보고');
  assert.equal(adapter.extractAssistantText({ type: 'text', part: { text: '' } }), null);
  assert.equal(adapter.extractAssistantText({ type: 'tool_use', part: { tool: 'bash' } }), null);
  assert.equal(adapter.extractAssistantText('nope'), null);
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

// ─── listModels / session probe must run a SHIM, not just a real binary ───────
//
// Windows regression (found on a live host): `opencode` installs as an npm batch
// shim (`%APPDATA%\npm\opencode.cmd`) with no sibling `.exe`, and the resolver
// deliberately falls back to that shim. The adapter used `execFileSync`, which
// calls CreateProcess directly and cannot execute a `.cmd` — it failed with
// EINVAL, and because both callers swallow failure into "no data" the result was
// silent: opencode reported ZERO models on every Windows host, which surfaced as
// the Orchestration slot editor showing a free-text model box there while Linux
// hosts got a dropdown. Measured on that host: execFileSync → EINVAL,
// cross-spawn → 76 models.
//
// POSIX cannot host a `.cmd`, so the portable stand-in is a shim whose PATH
// resolution and argv escaping exercise the same cross-spawn wrapping: a
// directory with a SPACE in it (plain `shell: true` would mis-split that) and a
// non-zero exit path. The structural guard below is what actually pins the
// Windows behaviour, since only cross-spawn can run a `.cmd` at all.

test('the adapter does not reach for execFileSync — a .cmd shim cannot be exec\'d directly', async () => {
  const src = await fsp.readFile(new URL('../src/lib/cli-adapters/opencode.ts', import.meta.url), 'utf8');
  assert.ok(
    !/\bexecFileSync\s*\(/.test(src),
    'opencode.ts must not call execFileSync: on Windows the resolved binary is an npm .cmd shim, '
      + 'which CreateProcess refuses (EINVAL) — every spawn here goes through cross-spawn',
  );
  assert.match(src, /from 'cross-spawn'/, 'and it must import cross-spawn to do so');
});

test('listModels parses, filters and dedupes a shim\'s output, even from a path containing a space', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencode models test-'));
  const shim = join(dir, 'opencode');
  await fsp.writeFile(
    shim,
    // Mirrors real output: a banner line, a blank line, ids, and a duplicate.
    '#!/bin/sh\n'
      + 'echo "opencode 1.18.32 — available models"\n'
      + 'echo ""\n'
      + 'echo "opencode/big-pickle"\n'
      + 'echo "opencode/space-bunny-free"\n'
      + 'echo "opencode/big-pickle"\n'
      + 'echo "not an id"\n',
    { mode: 0o755 },
  );
  const a = new OpencodeCliAdapter();
  a.resolveBin = () => shim;
  const models = await a.listModels();
  assert.deepEqual(models, ['opencode/big-pickle', 'opencode/space-bunny-free'],
    'banner/blank/spacey lines are dropped and ids are deduped, order preserved');
});

test('listModels degrades to [] — never throws — when the binary cannot be run or fails', async () => {
  const a = new OpencodeCliAdapter();
  a.resolveBin = () => join(tmpdir(), 'definitely-not-an-opencode-binary-' + Date.now());
  assert.deepEqual(await a.listModels(), [], 'an unrunnable binary means "no list", not a crashed heartbeat');

  const dir = mkdtempSync(join(tmpdir(), 'opencode-fail-'));
  const failing = join(dir, 'opencode');
  await fsp.writeFile(failing, '#!/bin/sh\necho "opencode/should-be-ignored"\nexit 3\n', { mode: 0o755 });
  a.resolveBin = () => failing;
  assert.deepEqual(await a.listModels(), [],
    'a non-zero exit is not a model list — partial stdout from a failed probe must not be trusted');
});

// ── opencode_auth credential ──────────────────────────────────────────────
//
// 기본은 여전히 credential-free(운영자 auth.json 심볼릭 링크)다. credential 을
// 묶으면 그 자리를 `OPENCODE_AUTH_CONTENT` env 가 대신한다 — opencode 가 그 env
// 를 파일보다 **우선**해서 읽고 파일은 건드리지 않는다(opencode 1.18.32 실측).
// 파일을 쓰지 않는 덕분에 운영자 홈이 전혀 관여하지 않고, 데이터 디렉터리도
// 제자리에 남아 그 에이전트의 세션이 Sessions 화면에 그대로 보인다.
test('prepareCliHome with an opencode_auth credential passes the auth through OPENCODE_AUTH_CONTENT and never writes it to disk', async () => {
  const fakeOperatorHome = await freshDir('awb-opencode-operator-');
  const operatorDataDir = join(fakeOperatorHome, '.local', 'share', 'opencode');
  await fsp.mkdir(operatorDataDir, { recursive: true });
  const operatorAuth = join(operatorDataDir, 'auth.json');
  await fsp.writeFile(operatorAuth, JSON.stringify({ openai: { type: 'api', key: 'OPERATOR-KEY' } }));

  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  process.env.HOME = fakeOperatorHome;
  process.env.USERPROFILE = fakeOperatorHome;
  try {
    const home = await freshDir();
    const adapter = new OpencodeCliAdapter();
    const authJson = JSON.stringify({ anthropic: { type: 'oauth', refresh: 'AGENT-REFRESH' } });
    const { extraEnv } = await adapter.prepareCliHome(
      home,
      { credential_id: 'cred-1', provider: 'opencode_auth', fields: { auth_json: authJson } },
      { url: 'https://awb.example', apiKey: 'k' },
    );
    assert.equal(extraEnv.OPENCODE_AUTH_CONTENT, authJson);
    assert.equal(extraEnv.XDG_CONFIG_HOME, join(home, '.config'));
    assert.equal(extraEnv.XDG_DATA_HOME, undefined,
      'the data dir must stay put — pinning it would hide the agent sessions from the Sessions screen');

    // 에이전트 홈에는 auth 파일이 생기지 않는다(링크도, 사본도).
    const agentAuth = join(home, '.local', 'share', 'opencode', 'auth.json');
    await assert.rejects(() => fsp.lstat(agentAuth), 'a bound credential must not leave an auth file in the agent home');

    // 그리고 운영자의 로그인은 글자 하나 바뀌지 않는다.
    assert.deepEqual(JSON.parse(await fsp.readFile(operatorAuth, 'utf8')), { openai: { type: 'api', key: 'OPERATOR-KEY' } });
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
  }
});

test('prepareCliHome without a credential still inherits the operator auth.json by symlink (unchanged default)', async () => {
  const fakeOperatorHome = await freshDir('awb-opencode-operator-');
  const operatorDataDir = join(fakeOperatorHome, '.local', 'share', 'opencode');
  await fsp.mkdir(operatorDataDir, { recursive: true });
  await fsp.writeFile(join(operatorDataDir, 'auth.json'), JSON.stringify({ openai: { type: 'api', key: 'OPERATOR-KEY' } }));

  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  process.env.HOME = fakeOperatorHome;
  process.env.USERPROFILE = fakeOperatorHome;
  try {
    const home = await freshDir();
    const adapter = new OpencodeCliAdapter();
    const { extraEnv } = await adapter.prepareCliHome(home, null, { url: 'https://awb.example', apiKey: 'k' });
    assert.equal(extraEnv.OPENCODE_AUTH_CONTENT, undefined);
    const agentAuth = join(home, '.local', 'share', 'opencode', 'auth.json');
    assert.deepEqual(JSON.parse(await fsp.readFile(agentAuth, 'utf8')), { openai: { type: 'api', key: 'OPERATOR-KEY' } });
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
  }
});

// credential 이 있는 에이전트에서만 벗겨 낸다(subagent-manager 가 그렇게 게이트한다).
// GITHUB_TOKEN 은 일부러 빠져 있다 — opencode 의 copilot 인증은 auth 파일에 있고,
// 그 env 는 에이전트의 gh/git 도구가 쓰는 값이다.
test('authEnvKeys strips operator provider keys that would compete with a bound credential, but not GITHUB_TOKEN', () => {
  const keys = new OpencodeCliAdapter().authEnvKeys();
  assert.deepEqual(keys.slice().sort(), ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'OPENAI_API_KEY']);
  assert.ok(!keys.includes('GITHUB_TOKEN'));
});
