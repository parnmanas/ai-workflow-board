// Regression: the server process must actually exit on SIGTERM.
//
// `server.close()` waits on open connections, and this server's clients keep
// them open by design. Two rounds of fixes were not enough on their own:
//
//   1. EventsController.shutdown$ completes the live SSE streams.
//   2. sessionStore.closeAll() closes the live MCP sessions.
//
// …and production still burned its whole stop timeout and was SIGKILLed on
// every restart. The missing piece is connection REUSE. A client behind a
// keep-alive pool — cloudflared, in front of this server — does not open a
// fresh TCP connection for its next request: the moment those hooks end its
// stream, it re-issues the request on the socket it already holds. That socket
// is ESTABLISHED, so the request is accepted even though the listener is
// closed, and the new stream is covered by neither hook (shutdown$ has already
// completed; closeAll has already run). One replacement stream per remote
// client is enough to block the close forever.
//
// Diagnosed on rolf 2026-09-17 by watching the sockets of a production process
// as it failed to stop: exactly two connections survived to the SIGKILL, both
// owned by cloudflared — one per remote agent manager (Ralf, Ragnar), while
// locally-connected Rolf's socket closed normally.
//
// curl cannot reproduce this: it opens a fresh connection per attempt, which is
// refused once the listener is closed. This test uses a pooled `http.Agent`
// that re-opens the stream on `end`, which is the shape that actually failed —
// and which hung for >40s against a build without main.ts's socket sweep, while
// the same build with it exits in ~1s.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.resolve(__dirname, '..', 'dist', 'main.js');

// Generous: a cold sqljs boot plus schema sync. The assertion is about the
// SHUTDOWN being bounded, not about boot speed.
const BOOT_TIMEOUT_MS = 120_000;
const SHUTDOWN_BUDGET_MS = 25_000;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function waitForHealth(port, deadline) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (Date.now() > deadline) return reject(new Error('server never became healthy'));
      const req = http.request({ host: '127.0.0.1', port, path: '/api/health', timeout: 2000 }, (res) => {
        res.resume();
        res.on('end', () => (res.statusCode === 200 ? resolve() : setTimeout(attempt, 500)));
      });
      req.on('error', () => setTimeout(attempt, 500));
      req.on('timeout', () => { req.destroy(); setTimeout(attempt, 500); });
      req.end();
    };
    attempt();
  });
}

test('SIGTERM exits the process even while a pooled client keeps re-opening a stream', async (t) => {
  if (!fs.existsSync(MAIN)) {
    t.skip('dist/main.js not built');
    return;
  }

  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-sigterm-'));

  const child = spawn(process.execPath, [MAIN], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(port),
      DB_TYPE: 'sqlite',
      AWB_DATA_DIR: dataDir,
      // Own throwaway sql.js files. The repo's shared database/data.db is dev
      // scratch that is routinely stale or corrupt, and this test has no
      // business booting from — or writing to — it.
      SQLJS_DB_PATH: path.join(dataDir, 'test.db'),
      SQLJS_ONTOLOGY_DB_PATH: path.join(dataDir, 'test-ontology.db'),
      // Lets the pooled client open MCP streams without provisioning a key.
      MCP_DEV_MODE: 'true',
      AGENT_DEV_MODE: 'true',
      // Keep the reaper/scheduler chatter out of a test that only measures exit.
      ORCHESTRATION_REAPER_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume();
  child.stderr.resume();

  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));

  let agent;
  try {
    await waitForHealth(port, Date.now() + BOOT_TIMEOUT_MS);

    // The cloudflared shape: pooled connections, re-opened the instant they end.
    agent = new http.Agent({ keepAlive: true, maxSockets: 2, keepAliveMsecs: 600_000 });
    let stop = false;

    // A GET /mcp without a session is answered and closed immediately — that is
    // not a stream and would not hold anything. Only a real initialized session
    // yields the long-lived text/event-stream this test needs.
    const initSession = () => new Promise((resolve) => {
      const body = JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: { experimental: { 'awb/schemaVersion': { version: 2 } } },
          clientInfo: { name: 'sigterm-test', version: '1' },
        },
      });
      const req = http.request(
        { host: '127.0.0.1', port, path: '/mcp', method: 'POST', agent,
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'content-length': Buffer.byteLength(body),
          } },
        (res) => { res.resume(); res.on('end', () => resolve(res.headers['mcp-session-id'] || null)); },
      );
      req.on('error', () => resolve(null));
      req.end(body);
    });

    const openStream = (sessionId) => {
      if (stop || !sessionId) return;
      const req = http.request(
        { host: '127.0.0.1', port, path: '/mcp', agent,
          headers: { accept: 'text/event-stream', 'mcp-session-id': sessionId } },
        (res) => {
          res.on('data', () => {});
          // Re-open on the pooled socket the instant the stream ends — this is
          // what defeats hooks that only close the streams alive at that moment.
          res.on('end', () => { if (!stop) void cycle(); });
          res.on('error', () => { if (!stop) void cycle(); });
        },
      );
      req.on('error', () => { if (!stop) setTimeout(() => void cycle(), 20); });
      req.end();
    };
    const cycle = async () => { openStream(await initSession()); };

    const first = await initSession();
    assert.ok(first, 'MCP initialize must succeed (MCP_DEV_MODE) — otherwise no stream is held and this proves nothing');
    openStream(first);
    void cycle();
    await new Promise((r) => setTimeout(r, 2000));

    const startedAt = Date.now();
    child.kill('SIGTERM');

    const outcome = await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), SHUTDOWN_BUDGET_MS)),
    ]);
    stop = true;

    assert.notEqual(
      outcome, 'TIMEOUT',
      `server did not exit within ${SHUTDOWN_BUDGET_MS}ms of SIGTERM — server.close() is waiting on a pooled ` +
      'connection whose stream was re-opened during shutdown; systemd would SIGKILL it here',
    );
    assert.notEqual(outcome.signal, 'SIGKILL', 'exit must be the process stopping itself, not a kill');
    t.diagnostic(`exited ${Date.now() - startedAt}ms after SIGTERM`);
  } finally {
    agent?.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
