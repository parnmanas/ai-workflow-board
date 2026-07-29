// Regression-grep — ticket 3960f036 (MCP McpServer orphan leak).
//
// McpController used to keep a standalone `agentId → McpServer` map alongside
// the per-session sessionStore. Keyed by the stable agentId and only deleted on
// close when no other session remained, it leaked an already-closed McpServer
// (+79 tool closures) on every out-of-order reconnect close. The fix removes
// that map. Execution delivery now uses the Runtime Host SSE path exclusively;
// MCP retains only request-scoped tool sessions.
//
// The behavioural proof lives in mcp-session-store-reconnect.test.mjs. This
// static check is the cheap, refactor-surviving guard that the duplicate
// source of truth does not creep back — a future edit re-introducing an
// agentId-keyed McpServer map would silently re-open the leak.
//
// Same shape as terminal-reopen-guard.test.mjs: strip comments first so the
// doc-prose that legitimately names the old map doesn't false-positive.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

function code(relPath) {
  const SOURCE = path.resolve(__dirname, '..', 'src', relPath);
  return stripComments(fs.readFileSync(SOURCE, 'utf8'));
}

test('McpController no longer holds an agentId → McpServer map', () => {
  const src = code('modules/mcp/mcp.controller.ts');
  // The leaked map and its mutations must all be gone.
  assert.doesNotMatch(src, /\bagentServers\b/, 'the agentServers map (and its set/delete/get) must not exist');
  // A Map<string, McpServer> field is the exact shape that leaked; reject it
  // regardless of the field name a future refactor might pick.
  assert.doesNotMatch(
    src,
    /new\s+Map<\s*string\s*,\s*McpServer\s*>/,
    'no agentId-keyed McpServer map may be reintroduced on the controller',
  );
});

test('McpController has no session-derived execution push target', () => {
  const src = code('modules/mcp/mcp.controller.ts');
  assert.doesNotMatch(
    src,
    /sessionStore\.getLatestServerForAgent\(/,
    'MCP must not select an Agent execution push target',
  );
});

test('SessionStore exposes only session-scoped McpServer lookup', () => {
  const src = code('modules/mcp/internal/session-store.ts');
  assert.doesNotMatch(
    src,
    /getLatestServerForAgent\s*\(/,
    'SessionStore must not expose an Agent execution push resolver',
  );
  assert.match(src, /get\(sessionId:\s*string\)/, 'tool sessions remain addressable by session id');
});
