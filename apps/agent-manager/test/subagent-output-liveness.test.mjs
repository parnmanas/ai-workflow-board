import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { SubagentManager } from '../dist/lib/subagent-manager.js';
import { OUTPUT_LIVENESS_MIN_INTERVAL_MS } from '../dist/lib/constants.js';

test('one-shot stdout reports liveness, throttles, and falls back from runtime to manager key', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), key: init.headers['X-Agent-Key'], body: JSON.parse(init.body) });
    return Response.json({}, { status: calls.length === 1 ? 403 : 200 });
  };
  const manager = new SubagentManager({ url: 'http://awb.test', apiKey: 'manager', delegation: { enabled: true } });
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const record = { pid: 991001, kind: 'trigger', cli_type: 'codex', ticket_id: 'ticket', agent_id: 'runtime', role: 'assignee',
    effectiveApiKey: 'runtime-key', process_handle: child, captureOutput: false, outLines: [], tailLines: [] };
  const feed = async (line) => { child.stdout.write(line + '\n'); await new Promise(r => setTimeout(r, 20)); };
  try {
    manager._wireStdioForTest(record);
    await feed('{}');
    assert.equal(calls.length, 0);
    await feed('{"type":"item.completed","item":{"type":"agent_message","text":"working"}}');
    assert.deepEqual(calls.map(c => c.key), ['runtime-key', 'manager']);
    assert.ok(calls.every(c => c.url.endsWith('/output-liveness')));
    assert.deepEqual(calls[0].body, { agent_id: 'runtime', ticket_id: 'ticket', role: 'assignee' });
    await feed('{"type":"turn.completed"}');
    assert.equal(calls.length, 2);
    record.lastLivenessPostAtMs -= OUTPUT_LIVENESS_MIN_INTERVAL_MS;
    await feed('{"type":"turn.completed"}');
    assert.equal(calls.length, 3);
    record.ticket_id = null;
    record.lastLivenessPostAtMs = 0;
    await feed('{"type":"turn.completed"}');
    assert.equal(calls.length, 3);
  } finally {
    child.stdout.end(); child.stderr.end();
    globalThis.fetch = original;
  }
});
