// Unit test — host-mcp stdio MCP server.
//
// Boots `dist/main.js mcp-host` as a real child process, drives the
// JSON-RPC protocol over stdio, and verifies:
//   (1) initialize + tools/list return the full advertised tool surface,
//   (2) a handful of side-effect-free tools (os_info, list_screens,
//       find_unity_logs) actually execute and return well-formed payloads,
//   (3) the server shuts down cleanly on SIGTERM.
//
// We deliberately avoid the GUI tools (screenshot / send_keys / mouse_*)
// because the test harness runs headless on every CI platform; those tools
// would either fail loudly (no DISPLAY) or, worse, succeed and click on
// whatever the developer happens to have on screen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const MAIN_JS = resolve(here, '..', 'dist', 'main.js');

/**
 * Boot the MCP server, run a sequence of JSON-RPC frames against it,
 * collect responses keyed by request id, then teardown.
 */
async function withMcpServer(fn) {
  const child = spawn(process.execPath, [MAIN_JS, 'mcp-host'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (b) => { stdout += b.toString(); });
  // stderr is only diagnostic; don't pollute the test runner output.
  child.stderr.on('data', () => {});

  const responses = new Map();
  const pending = new Map();

  // Re-parse stdout on every chunk and resolve waiters whose id has arrived.
  const drainResponses = () => {
    for (const line of stdout.split('\n').filter(Boolean)) {
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id == null) continue;
      responses.set(msg.id, msg);
      const w = pending.get(msg.id);
      if (w) { pending.delete(msg.id); w(msg); }
    }
  };
  child.stdout.on('data', drainResponses);

  const call = (id, method, params) => {
    const frame = { jsonrpc: '2.0', id, method, params };
    child.stdin.write(JSON.stringify(frame) + '\n');
    if (responses.has(id)) return Promise.resolve(responses.get(id));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`mcp call timeout (id=${id} method=${method})`));
      }, 10_000);
      pending.set(id, (msg) => { clearTimeout(t); resolve(msg); });
    });
  };

  try {
    // Required handshake before any tools/list / tools/call.
    await call(1, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    await fn(call);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
  }
}

function unwrapText(rpc) {
  const text = rpc?.result?.content?.[0]?.text;
  assert.equal(typeof text, 'string', `tool reply missing text content: ${JSON.stringify(rpc)}`);
  return JSON.parse(text);
}

test('tools/list advertises the full host-mcp surface', async () => {
  await withMcpServer(async (call) => {
    const reply = await call(2, 'tools/list', {});
    const tools = reply.result?.tools ?? [];
    const names = tools.map((t) => t.name).sort();
    const expected = [
      'clipboard_read', 'clipboard_write', 'find_unity_logs', 'focus_window',
      'kill_process', 'launch_process', 'list_processes', 'list_screens',
      'list_windows', 'mouse_click', 'mouse_move', 'os_info', 'read_file_tail',
      'screenshot', 'send_keys', 'shell_exec', 'wait_for_file', 'window_screenshot',
    ];
    for (const want of expected) {
      assert.ok(names.includes(want), `missing tool: ${want} (have ${names.join(',')})`);
    }
    // Every tool must have a non-empty description so the model has context.
    for (const tool of tools) {
      assert.ok(typeof tool.description === 'string' && tool.description.length > 20,
        `tool ${tool.name} needs a fuller description (got: ${JSON.stringify(tool.description)})`);
    }
  });
});

test('os_info returns a populated host record', async () => {
  await withMcpServer(async (call) => {
    const reply = await call(3, 'tools/call', { name: 'os_info', arguments: {} });
    const payload = unwrapText(reply);
    assert.equal(typeof payload.platform, 'string');
    assert.ok(['win32', 'darwin', 'linux'].includes(payload.platform), `unexpected platform: ${payload.platform}`);
    assert.equal(typeof payload.hostname, 'string');
    assert.equal(typeof payload.cpu_count, 'number');
    assert.ok(payload.cpu_count > 0);
  });
});

test('find_unity_logs returns the per-OS search set even when no Unity is installed', async () => {
  await withMcpServer(async (call) => {
    const reply = await call(4, 'tools/call', { name: 'find_unity_logs', arguments: {} });
    const payload = unwrapText(reply);
    assert.equal(payload.ok, true);
    assert.ok(Array.isArray(payload.searched), 'searched must be an array');
    assert.ok(payload.searched.length >= 3, 'should probe at least editor_log/editor_prev/crash');
    // platform field is always set; project info only when project_path was given.
    assert.ok(['win32', 'darwin', 'linux'].includes(payload.platform));
    assert.equal(payload.project, null);
  });
});

test('list_screens returns ok with a monitor list (even if empty on headless)', async () => {
  await withMcpServer(async (call) => {
    const reply = await call(5, 'tools/call', { name: 'list_screens', arguments: {} });
    const payload = unwrapText(reply);
    // Either ok with monitors[] (possibly empty + warning) OR an error with hint.
    // Both shapes are valid — what we forbid is an unhandled throw.
    if (reply.result?.isError) {
      assert.equal(typeof payload.error, 'string');
    } else {
      assert.equal(typeof payload.count, 'number');
      assert.ok(Array.isArray(payload.monitors));
    }
  });
});
