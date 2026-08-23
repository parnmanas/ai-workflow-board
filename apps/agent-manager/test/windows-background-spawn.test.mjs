import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('host command runner hides child console windows on Windows', async () => {
  const source = await readFile(new URL('../dist/lib/host-mcp/platform.js', import.meta.url), 'utf8');
  assert.match(source, /windowsHide:\s*hostPlatform\(\)\s*===\s*['"]win32['"]/);
});

test('persistent session spawn has a final per-key guard', async () => {
  const source = await readFile(new URL('../dist/lib/base-session-manager.js', import.meta.url), 'utf8');
  assert.match(source, /#spawningSessionKeys\s*=\s*new Set/);
  assert.match(source, /spawn blocked by final session-key guard/);
});
