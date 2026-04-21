// Global trace buffer for QA flow tests.
//
// When a test subprocess is spawned by qa.controller with QA_TRACE_PATH set,
// every helper (bootApp, McpClient, VirtualAgent, fixtures) records
// structured events here, and `writeTrace()` flushes the buffer to disk on
// exit. The parent process reads that JSON back and attaches it to the
// QaRunner test result so the UI can render a rich timeline of what the
// test actually did: fixtures created, SSE frames received, MCP requests
// and responses (with bodies), and explicit step() markers.
//
// Size-safety:
//   - Individual payloads are truncated to MAX_PAYLOAD_CHARS (keeps the
//     get_ticket response visible but prevents 10MB log dumps).
//   - Event count is capped at MAX_EVENTS per test; later events are
//     dropped with a single "trace overflow" marker so the UI can warn.

import fs from 'node:fs';

const MAX_EVENTS = 5000;
const MAX_PAYLOAD_CHARS = 4000;

const buffer = [];
let started = false;
let startedAt = 0;
let overflowed = false;

const now = () => Date.now();

function truncate(obj) {
  if (obj === undefined) return undefined;
  try {
    const s = JSON.stringify(obj);
    if (s.length <= MAX_PAYLOAD_CHARS) return JSON.parse(s);
    return { _truncated: true, _original_len: s.length, preview: s.slice(0, MAX_PAYLOAD_CHARS) + '...' };
  } catch {
    return { _unrepresentable: true };
  }
}

export function traceEvent(type, data = {}) {
  if (!started) return;
  if (buffer.length >= MAX_EVENTS) {
    if (!overflowed) {
      overflowed = true;
      buffer.push({ t: now() - startedAt, type: 'trace-overflow', dropped_after: MAX_EVENTS });
    }
    return;
  }
  // Shallow-copy + per-field truncate so callers don't have to think about
  // payload sizes and the file stays bounded no matter what a test throws at us.
  const out = { t: now() - startedAt, type };
  for (const [k, v] of Object.entries(data)) {
    out[k] = typeof v === 'object' && v !== null ? truncate(v) : v;
  }
  buffer.push(out);
}

/** Explicit test-authored step marker — shows up as a headline in the UI. */
export function step(label, extra = {}) {
  traceEvent('step', { label, ...extra });
}

/** Called once per test subprocess (from bootApp). Idempotent. */
export function startTrace({ testFile } = {}) {
  if (started) return;
  started = true;
  startedAt = now();
  buffer.push({ t: 0, type: 'trace-start', test_file: testFile || process.env.QA_TEST_FILE || 'unknown', pid: process.pid });
}

/** Dump buffer to QA_TRACE_PATH (set by the parent qa.controller). */
export function writeTrace() {
  if (!started) return;
  buffer.push({ t: now() - startedAt, type: 'trace-end', events: buffer.length });
  const outPath = process.env.QA_TRACE_PATH;
  if (!outPath) return;
  try {
    fs.writeFileSync(outPath, JSON.stringify(buffer));
  } catch (err) {
    // Can't log nicely since the process is about to exit anyway.
    console.error('[trace] write failed:', String(err));
  }
}

export function getBuffer() {
  return buffer.slice();
}
