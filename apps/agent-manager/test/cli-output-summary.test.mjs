// Unit test — summarizeCliJsonLine (ticket ac958c06).
//
// The silent-exit fallback tail used to drop every stream-json line, so a
// session that died mid-stream-json (the default claude/deepseek path) left an
// empty tail → "(no buffered CLI output captured)". This summarizer condenses
// those JSON events into prose so the tail carries real diagnostic signal.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { summarizeCliJsonLine } from '../dist/lib/cli-output-summary.js';

test('non-JSON / empty / unparseable input → null (caller keeps plain text)', () => {
  assert.equal(summarizeCliJsonLine(''), null);
  assert.equal(summarizeCliJsonLine('   '), null);
  assert.equal(summarizeCliJsonLine('WARN: plain text line'), null);
  assert.equal(summarizeCliJsonLine('{ not valid json'), null);
  assert.equal(summarizeCliJsonLine('null'), null);
});

test('system/init event → null (noise, proves a start not a death)', () => {
  const line = JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-4-8' });
  assert.equal(summarizeCliJsonLine(line), null);
});

test('assistant text → "assistant: <text>"', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'I will now move the ticket.' }] },
  });
  const out = summarizeCliJsonLine(line);
  assert.ok(out);
  assert.match(out, /^assistant: I will now move the ticket\./);
});

test('assistant tool_use → "→ tool(name)"', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'mcp__awb__add_comment', input: {} }] },
  });
  const out = summarizeCliJsonLine(line);
  assert.ok(out);
  assert.match(out, /→ tool\(mcp__awb__add_comment\)/);
});

test('result success → carries subtype + is_error + turns', () => {
  const line = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 4,
    result: 'Done.',
  });
  const out = summarizeCliJsonLine(line);
  assert.ok(out);
  assert.match(out, /result: subtype=success/);
  assert.match(out, /is_error=false/);
  assert.match(out, /turns=4/);
  assert.match(out, /Done\./);
});

test('result error → non-empty tail with the failure reason text', () => {
  // This is the exact case that produced "(no buffered CLI output captured)":
  // a stream-json result event reporting an error, with empty stderr.
  const line = JSON.stringify({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    result: 'API Error: 429 usage limit reached',
  });
  const out = summarizeCliJsonLine(line);
  assert.ok(out && out.length > 0, 'must produce a non-empty summary');
  assert.match(out, /subtype=error_during_execution/);
  assert.match(out, /is_error=true/);
  assert.match(out, /429 usage limit reached/);
});

test('tool_result error (user echo) is surfaced; normal tool_result is skipped', () => {
  const errLine = JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', is_error: true, content: 'ENOENT: no such file' }] },
  });
  const okLine = JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', is_error: false, content: 'file contents...' }] },
  });
  assert.match(summarizeCliJsonLine(errLine) ?? '', /tool_result error: ENOENT/);
  assert.equal(summarizeCliJsonLine(okLine), null);
});

test('top-level error / stream_error events are surfaced', () => {
  assert.match(
    summarizeCliJsonLine(JSON.stringify({ type: 'error', error: 'connection reset' })) ?? '',
    /error: connection reset/,
  );
  assert.match(
    summarizeCliJsonLine(JSON.stringify({ type: 'stream_error', message: 'overloaded_error' })) ?? '',
    /error: overloaded_error/,
  );
});

test('unknown event type is kept only when it reports a failure', () => {
  assert.equal(summarizeCliJsonLine(JSON.stringify({ type: 'ping' })), null);
  assert.match(
    summarizeCliJsonLine(JSON.stringify({ type: 'weird', is_error: true, error: 'boom' })) ?? '',
    /error: boom/,
  );
});

test('a long result blob is clipped, not unbounded', () => {
  const huge = 'x'.repeat(5000);
  const line = JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: huge });
  const out = summarizeCliJsonLine(line);
  assert.ok(out);
  // header + clipped body must stay well under the 5000-char raw size.
  assert.ok(out.length < 1000, `expected clipped output, got ${out.length} chars`);
  assert.match(out, /…$/);
});
