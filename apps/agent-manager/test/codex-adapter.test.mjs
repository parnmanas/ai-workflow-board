import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';

import {
  CodexCliAdapter,
  validateCodexMcpServers,
  InvalidMcpTransportError,
  CODEX_MCP_TRANSPORTS,
} from '../dist/lib/cli-adapters/codex.js';
import { ADAPTER_CAPABILITIES } from '../dist/lib/cli-adapters/base.js';

const tempDirs = [];

async function freshDir(prefix = 'awb-codex-adapter-') {
  const dir = await fsp.mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function readConfig(home) {
  const text = await fsp.readFile(join(home, 'config.toml'), 'utf8');
  return { text, config: parse(text) };
}

afterEach(async () => {
  delete process.env.CODEX_HOME;
  await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

test('Codex declares native MCP without claiming persistent-session support', () => {
  const adapter = new CodexCliAdapter();
  assert.equal(adapter.has(ADAPTER_CAPABILITIES.NATIVE_MCP), true);
  assert.equal(adapter.has(ADAPTER_CAPABILITIES.PERSISTENT_SESSION), false);
});

test('listModels returns the visible account-aware Codex model cache', async () => {
  const home = await freshDir();
  process.env.CODEX_HOME = home;
  await fsp.writeFile(join(home, 'models_cache.json'), JSON.stringify({
    models: [
      { slug: 'gpt-5.6-sol', visibility: 'list' },
      { slug: 'gpt-5.6-terra', visibility: 'list' },
      { slug: 'codex-auto-review', visibility: 'hide' },
      { slug: 'gpt-5.6-sol', visibility: 'list' },
    ],
  }));

  assert.deepEqual(await new CodexCliAdapter().listModels(), [
    'gpt-5.6-sol',
    'gpt-5.6-terra',
  ]);
});

test('listModels degrades to free-text mode when Codex has no cache yet', async () => {
  const home = await freshDir();
  process.env.CODEX_HOME = home;
  assert.deepEqual(await new CodexCliAdapter().listModels(), []);
});

test('buildOneshotSpawn adds ticket attribution as a TOML config override', () => {
  const adapter = new CodexCliAdapter();
  const descriptor = adapter.buildOneshotSpawn({
    rolePrompt: 'role',
    taskText: 'task',
    mcpConfigPath: null,
    mcpAttribution: {
      ticketId: 'ticket-123',
      role: 'reviewer',
      triggerSource: 'ticket_done_review',
    },
  });
  const configIndex = descriptor.args.indexOf('-c');
  assert.ok(configIndex >= 0);
  const override = descriptor.args[configIndex + 1];
  const prefix = 'mcp_servers.awb.http_headers=';
  assert.ok(override.startsWith(prefix));
  const headers = parse(`headers = ${override.slice(prefix.length)}`).headers;
  assert.deepEqual(headers, {
    'X-AWB-Client-Type': 'managed-subagent',
    'X-AWB-Subagent-Ticket-Id': 'ticket-123',
    'X-AWB-Subagent-Role': 'reviewer',
    'X-AWB-Subagent-Trigger-Source': 'ticket_done_review',
  });
});

test('buildOneshotSpawn omits per-run MCP override for unattributed chat runs', () => {
  const adapter = new CodexCliAdapter();
  const descriptor = adapter.buildOneshotSpawn({
    rolePrompt: 'role',
    taskText: 'task',
    mcpConfigPath: null,
  });
  assert.equal(descriptor.args.includes('-c'), false);
});

test('buildOneshotSpawn pins Codex workspace root to the manager-selected cwd', () => {
  const adapter = new CodexCliAdapter();
  const cwd = '/repo/.awb/wt/12345678';
  const descriptor = adapter.buildOneshotSpawn({
    rolePrompt: 'role',
    taskText: 'task',
    mcpConfigPath: null,
    cwd,
  });
  const cdIndex = descriptor.args.indexOf('--cd');
  assert.ok(cdIndex >= 0, 'Codex must receive an explicit workspace root');
  assert.equal(descriptor.args[cdIndex + 1], cwd);
});

test('buildOneshotSpawn omits --cd when no cwd was resolved', () => {
  const adapter = new CodexCliAdapter();
  const descriptor = adapter.buildOneshotSpawn({
    rolePrompt: 'role',
    taskText: 'task',
    mcpConfigPath: null,
  });
  assert.equal(descriptor.args.includes('--cd'), false);
});

test('prepareCliHome writes required AWB and optional host MCP without persisting the API key', async () => {
  const adapter = new CodexCliAdapter();
  const home = await freshDir();

  await adapter.prepareCliHome(home, null, {
    url: 'https://awb.example.com/',
    apiKey: 'sk-agent-123',
  });

  const { text, config } = await readConfig(home);
  assert.equal(config.mcp_servers.awb.url, 'https://awb.example.com/mcp');
  assert.equal(config.mcp_servers.awb.bearer_token_env_var, 'AWB_API_KEY');
  assert.equal(config.mcp_servers.awb.required, true);
  assert.equal(config.mcp_servers.awb.http_headers['X-AWB-Client-Type'], 'managed-subagent');
  assert.equal(config.mcp_servers.host.required, undefined);
  assert.equal(typeof config.mcp_servers.host.command, 'string');
  assert.ok(config.mcp_servers.host.args.at(-1) === 'mcp-host');
  assert.ok(!text.includes('sk-agent-123'));
  assert.equal((await fsp.stat(join(home, 'config.toml'))).isFile(), true);
});

test('prepareCliHome preserves unrelated Codex settings and MCP servers while refreshing managed entries', async () => {
  const adapter = new CodexCliAdapter();
  const home = await freshDir();
  await fsp.writeFile(
    join(home, 'config.toml'),
    [
      'model = "gpt-5.4"',
      '[mcp_servers.existing]',
      'command = "/bin/existing"',
      '[mcp_servers.awb]',
      'url = "https://stale.example/mcp"',
      '',
    ].join('\n'),
  );

  await adapter.prepareCliHome(home, null, {
    url: 'http://localhost:7701',
    apiKey: 'secret-not-for-toml',
  });
  await adapter.prepareCliHome(home, null, {
    url: 'https://new.example/',
    apiKey: 'rotated-secret',
  });

  const { text, config } = await readConfig(home);
  assert.equal(config.model, 'gpt-5.4');
  assert.equal(config.mcp_servers.existing.command, '/bin/existing');
  assert.equal(config.mcp_servers.awb.url, 'https://new.example/mcp');
  assert.equal((text.match(/\[mcp_servers\.awb\]/g) ?? []).length, 1);
  assert.ok(!text.includes('secret-not-for-toml'));
  assert.ok(!text.includes('rotated-secret'));
});

test('prepareCliHome rejects invalid TOML without overwriting it', async () => {
  const adapter = new CodexCliAdapter();
  const home = await freshDir();
  const configPath = join(home, 'config.toml');
  const invalid = '[mcp_servers.awb\nurl = "broken"';
  await fsp.writeFile(configPath, invalid);

  await assert.rejects(
    adapter.prepareCliHome(home, null, { url: 'https://awb.example.com', apiKey: 'key' }),
  );
  assert.equal(await fsp.readFile(configPath, 'utf8'), invalid);
});

// ── parseProgressEvent — chat one-shot heartbeats (ticket c47194d9) ─────────
// Real `codex exec --json` thread events → normalized {kind,label,detail,status}.

test('parseProgressEvent maps command_execution start → 작업 중 (start)', () => {
  const ev = new CodexCliAdapter().parseProgressEvent({
    type: 'item.started',
    item: { id: 'i0', type: 'command_execution', command: 'bash -lc ls', status: 'in_progress' },
  });
  assert.deepEqual(ev, { kind: 'command', label: '명령', detail: 'bash -lc ls', status: 'start' });
});

test('parseProgressEvent maps a clean command_execution completion → 완료 (success)', () => {
  const ev = new CodexCliAdapter().parseProgressEvent({
    type: 'item.completed',
    item: { id: 'i0', type: 'command_execution', command: 'git status', exit_code: 0, status: 'completed' },
  });
  assert.deepEqual(ev, { kind: 'command', label: '명령', detail: 'git status', status: 'success' });
});

test('parseProgressEvent maps a non-zero command_execution completion → 실패 (error)', () => {
  const ev = new CodexCliAdapter().parseProgressEvent({
    type: 'item.completed',
    item: { id: 'i0', type: 'command_execution', command: 'npm test', exit_code: 1, status: 'completed' },
  });
  assert.equal(ev.status, 'error');
  assert.equal(ev.kind, 'command');
  assert.equal(ev.detail, 'npm test');
});

test('parseProgressEvent labels an MCP tool call by server:tool', () => {
  const ev = new CodexCliAdapter().parseProgressEvent({
    type: 'item.started',
    item: { id: 'i1', type: 'mcp_tool_call', server: 'awb', tool: 'add_comment', status: 'in_progress' },
  });
  assert.deepEqual(ev, { kind: 'tool', label: 'awb:add_comment', detail: '', status: 'start' });
});

test('parseProgressEvent marks an MCP tool call with error → 실패', () => {
  const ev = new CodexCliAdapter().parseProgressEvent({
    type: 'item.completed',
    item: { id: 'i1', type: 'mcp_tool_call', server: 'awb', tool: 'get_ticket', error: 'boom' },
  });
  assert.equal(ev.status, 'error');
  assert.equal(ev.label, 'awb:get_ticket');
});

test('parseProgressEvent EXCLUDES send_chat_room_message (the reply itself)', () => {
  const adapter = new CodexCliAdapter();
  for (const type of ['item.started', 'item.completed']) {
    assert.equal(
      adapter.parseProgressEvent({
        type,
        item: { type: 'mcp_tool_call', server: 'awb', tool: 'send_chat_room_message', error: null },
      }),
      null,
    );
  }
});

test('parseProgressEvent EXCLUDES agent_message / reasoning / todo_list noise', () => {
  const adapter = new CodexCliAdapter();
  assert.equal(
    adapter.parseProgressEvent({ type: 'item.completed', item: { type: 'agent_message', text: 'hi' } }),
    null,
  );
  assert.equal(
    adapter.parseProgressEvent({ type: 'item.completed', item: { type: 'reasoning', text: '...' } }),
    null,
  );
  assert.equal(
    adapter.parseProgressEvent({ type: 'item.started', item: { type: 'todo_list', items: [] } }),
    null,
  );
});

test('parseProgressEvent summarizes a file_change with multiple paths', () => {
  const ev = new CodexCliAdapter().parseProgressEvent({
    type: 'item.completed',
    item: {
      type: 'file_change',
      status: 'completed',
      changes: [{ path: 'src/a.ts', kind: 'update' }, { path: 'src/b.ts', kind: 'add' }],
    },
  });
  assert.equal(ev.kind, 'file');
  assert.equal(ev.label, '파일 변경');
  assert.equal(ev.detail, 'src/a.ts 외 1건');
  assert.equal(ev.status, 'success');
});

test('parseProgressEvent maps web_search → 웹 검색 with the query', () => {
  const ev = new CodexCliAdapter().parseProgressEvent({
    type: 'item.started',
    item: { type: 'web_search', query: 'nestjs sse' },
  });
  assert.deepEqual(ev, { kind: 'search', label: '웹 검색', detail: 'nestjs sse', status: 'start' });
});

test('parseProgressEvent maps turn.failed / error → 실패 with the message', () => {
  const adapter = new CodexCliAdapter();
  const a = adapter.parseProgressEvent({ type: 'turn.failed', error: { message: 'usage limit' } });
  assert.equal(a.status, 'error');
  assert.equal(a.detail, 'usage limit');
  const b = adapter.parseProgressEvent({ type: 'error', message: 'stream broke' });
  assert.equal(b.status, 'error');
  assert.equal(b.detail, 'stream broke');
});

test('parseProgressEvent returns null for envelope/noise/garbage events', () => {
  const adapter = new CodexCliAdapter();
  for (const raw of [
    { type: 'thread.started' },
    { type: 'turn.started' },
    { type: 'turn.completed' },
    { type: 'item.completed' }, // no item
    null,
    'not-an-object',
    { type: 'item.started', item: null },
  ]) {
    assert.equal(adapter.parseProgressEvent(raw), null);
  }
});

test('prepareCliHome replaces an inherited config symlink without modifying the operator target', async (t) => {
  const adapter = new CodexCliAdapter();
  const operatorHome = await freshDir('awb-codex-operator-');
  const agentHome = await freshDir('awb-codex-agent-');
  const operatorConfig = join(operatorHome, 'config.toml');
  const agentConfig = join(agentHome, 'config.toml');
  const originalOperatorText = 'model = "gpt-5.4"\n';
  await fsp.writeFile(operatorConfig, originalOperatorText);
  try {
    await fsp.symlink(operatorConfig, agentConfig, 'file');
  } catch (err) {
    if (err?.code === 'EPERM' || err?.code === 'EACCES') {
      t.skip(`file symlinks unavailable: ${err.code}`);
      return;
    }
    throw err;
  }

  await adapter.prepareCliHome(agentHome, null, {
    url: 'https://awb.example.com',
    apiKey: 'key',
  });

  assert.equal((await fsp.lstat(agentConfig)).isSymbolicLink(), false);
  assert.equal(await fsp.readFile(operatorConfig, 'utf8'), originalOperatorText);
  const { config } = await readConfig(agentHome);
  assert.equal(config.model, 'gpt-5.4');
  assert.equal(config.mcp_servers.awb.required, true);
});

// ── MCP transport validation (ticket 40d18474) ──────────────────────────────
// codex aborts config loading with `invalid transport in mcp_servers.<name>`
// (exit 1 → silent subagent exit) for any server it can't resolve to a
// transport. Incident 26a92722: a managed codex reviewer died twice this way.

test('CODEX_MCP_TRANSPORTS is the codex-supported allow-list', () => {
  assert.deepEqual([...CODEX_MCP_TRANSPORTS], ['stdio', 'streamable_http']);
});

test('validateCodexMcpServers accepts url (streamable_http), command (stdio) and explicit supported transports', () => {
  assert.doesNotThrow(() =>
    validateCodexMcpServers(
      {
        mcp_servers: {
          awb: { url: 'https://awb.example/mcp', bearer_token_env_var: 'AWB_API_KEY', required: true },
          host: { command: '/usr/bin/node', args: ['main.js', 'mcp-host'] },
          extra: { transport: 'streamable_http', url: 'https://extra.example' },
        },
      },
      '/home/agent/config.toml',
    ),
  );
});

test('validateCodexMcpServers treats a config without mcp_servers as vacuously valid', () => {
  for (const c of [{}, { model: 'gpt-5.4' }, null, undefined, { mcp_servers: null }]) {
    assert.doesNotThrow(() => validateCodexMcpServers(c, '/c'), `vacuous: ${JSON.stringify(c)}`);
  }
});

test('validateCodexMcpServers rejects a transport-less awb (the invalid-transport incident 26a92722)', () => {
  // A headers-only awb — exactly what the always-injected
  // `-c mcp_servers.awb.http_headers` override manufactures when config.toml
  // carries no complete awb — has neither url nor command.
  assert.throws(
    () =>
      validateCodexMcpServers(
        { mcp_servers: { awb: { http_headers: { 'X-AWB-Client-Type': 'managed-subagent' } } } },
        '/home/agent/config.toml',
      ),
    (err) => {
      assert.ok(err instanceof InvalidMcpTransportError, 'InvalidMcpTransportError');
      assert.match(err.message, /mcp_servers\.awb/, 'names the offending server key');
      assert.match(err.message, /\/home\/agent\/config\.toml/, 'names the config path');
      assert.match(err.message, /stdio, streamable_http/, 'lists the allowed transports');
      return true;
    },
  );
});

test('validateCodexMcpServers rejects an explicit transport outside the allow-list', () => {
  for (const bad of ['http', 'sse', 'ws', 'streamablehttp']) {
    assert.throws(
      () => validateCodexMcpServers({ mcp_servers: { awb: { transport: bad, url: 'https://x' } } }, '/c'),
      (err) => {
        assert.ok(err instanceof InvalidMcpTransportError, `InvalidMcpTransportError for ${bad}`);
        assert.ok(err.message.includes(`transport = "${bad}"`), `echoes the bad value ${bad}`);
        assert.match(err.message, /stdio, streamable_http/, 'lists the allowed transports');
        return true;
      },
    );
  }
});

test('validateCodexMcpServers rejects an explicit transport inconsistent with its fields', () => {
  assert.throws(
    () => validateCodexMcpServers({ mcp_servers: { awb: { transport: 'streamable_http' } } }, '/c'),
    (err) => err instanceof InvalidMcpTransportError && /requires a "url"/.test(err.message),
  );
  assert.throws(
    () => validateCodexMcpServers({ mcp_servers: { host: { transport: 'stdio' } } }, '/c'),
    (err) => err instanceof InvalidMcpTransportError && /requires a "command"/.test(err.message),
  );
  // A non-table entry is rejected too.
  assert.throws(
    () => validateCodexMcpServers({ mcp_servers: { junk: 'nope' } }, '/c'),
    (err) => err instanceof InvalidMcpTransportError && /mcp_servers\.junk/.test(err.message),
  );
});

test('prepareCliHome writes a valid awb transport even when the per-agent apiKey is absent (root cause of 26a92722)', async () => {
  // The awb block never embeds the key (bearer comes from the AWB_API_KEY env
  // var), so an absent apiKey must NOT drop awb — otherwise the spawn-time
  // `-c mcp_servers.awb.http_headers` override manufactures a transport-less
  // awb and codex aborts config loading. Isolate CODEX_HOME so no operator
  // config is inherited.
  const adapter = new CodexCliAdapter();
  const home = await freshDir();
  process.env.CODEX_HOME = await freshDir('awb-codex-emptymain-');

  await adapter.prepareCliHome(home, null, { url: 'https://awb.example.com', apiKey: '' });

  const { config } = await readConfig(home);
  assert.equal(config.mcp_servers.awb.url, 'https://awb.example.com/mcp');
  assert.equal(config.mcp_servers.awb.required, true);
  assert.equal(typeof config.mcp_servers.host.command, 'string');
});

test('prepareCliHome refuses (without overwriting) when an inherited MCP server has no resolvable transport', async () => {
  // A preserved operator server with neither url nor command must be caught
  // before codex is handed the config — as a clear InvalidMcpTransportError,
  // and the original file must stay intact (validation precedes the write).
  const adapter = new CodexCliAdapter();
  const home = await freshDir();
  process.env.CODEX_HOME = await freshDir('awb-codex-emptymain-');
  const configPath = join(home, 'config.toml');
  const broken = ['[mcp_servers.legacy]', 'http_headers = { "X-Trace" = "1" }', ''].join('\n');
  await fsp.writeFile(configPath, broken);

  await assert.rejects(
    adapter.prepareCliHome(home, null, { url: 'https://awb.example.com', apiKey: 'k' }),
    (err) => err instanceof InvalidMcpTransportError && /mcp_servers\.legacy/.test(err.message),
  );
  assert.equal(await fsp.readFile(configPath, 'utf8'), broken);
});
