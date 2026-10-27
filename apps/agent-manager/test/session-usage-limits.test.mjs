import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexUsageLimits } from '../dist/lib/clis/codex/usage-limits.js';
import { AgentSessionStore } from '../dist/lib/agent-session-store.js';

const sid = '019d5d74-427c-7d13-b1c4-a54e0081374a';
const record = (percent = 42, timestamp = '2026-10-27T10:00:00Z') => ({ type: 'event_msg', timestamp, payload: { type: 'token_count', info: null, rate_limits: {
  primary: { used_percent: percent, window_minutes: 300, resets_at: 1793124000 },
  secondary: { used_percent: 0, window_minutes: 10080, resets_at: 1793549361 },
  credits: { balance: 'secret-or-irrelevant' },
} } });
const line = (row) => JSON.stringify(row) + '\n';

test('native quota mapping retains zero and both windows, omitting credentials and unrelated fields', () => {
  const result = codexUsageLimits(record());
  assert.equal(result.windows[0].used_percent, 42);
  assert.equal(result.windows[1].used_percent, 0);
  assert.equal(result.windows[1].window_minutes, 10080);
  assert.equal(result.windows[0].resets_at, new Date(1793124000000).toISOString());
  assert.equal(result.credits, undefined);
  assert.equal(codexUsageLimits(record(120)).windows[0].used_percent, 100);
  assert.equal(codexUsageLimits({}), null);
  assert.equal(codexUsageLimits(record(1, 'invalid')), null);
  const invalid = record(); invalid.payload.rate_limits.primary.used_percent = '42';
  assert.equal(codexUsageLimits(invalid).windows.length, 1);
});

test('quota survives trimmed history and live collection updates once per native report', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-quota-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'sessions', '2026', '10', '27');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `rollout-test-${sid}.jsonl`);
  await writeFile(path, [
    { type: 'session_meta', payload: { id: sid, cwd: '/repo' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: 'Task' } },
    record(),
    ...Array.from({ length: 40 }, (_, i) => ({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: `Reply ${i}` } })),
  ].map(line).join(''));
  const store = new AgentSessionStore({ homes: { codex: root }, historyEventLimit: 5, indexPath: join(root, 'index.json') });
  const history = await store.readHistory('codex', sid);
  assert.equal(history.truncated, true);
  const quotas = history.events.filter((e) => e.type === 'usage_limits');
  assert.equal(quotas.length, 1);
  assert.equal(quotas[0].payload.windows[0].used_percent, 42);
  const received = [];
  const watcher = await store.watchUsageLimits('codex', sid, (limits) => received.push(limits));
  t.after(() => watcher?.close());
  assert.equal(received.length, 1);
  await watcher.poll();
  assert.equal(received.length, 1);
  await appendFile(path, line(record(75, '2026-10-27T11:00:00Z')));
  await watcher.poll();
  assert.equal(received.at(-1).windows[0].used_percent, 75);
  assert.equal(received.length, 2);
  watcher.close();
  await appendFile(path, line(record(90, '2026-10-27T12:00:00Z')));
  await watcher.poll();
  assert.equal(received.length, 2);
  assert.equal(await store.watchUsageLimits('claude', sid, () => {}), null);
});
