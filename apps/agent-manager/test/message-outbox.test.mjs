// Unit test — durable send outbox (offline message buffering + replay).
//
// Validates:
//   (a) enqueue → persist → load round-trip: a second instance rehydrates the
//       exact FIFO queue a dead manager left on disk.
//   (b) flush semantics: FIFO order, 'ok'/'permanent' remove the entry,
//       first 'retryable' pauses the pass and keeps the tail intact,
//       expired entries (per-kind TTL) are dropped without sending.
//   (c) rest.ts wrapper integration: a network-level fetch failure enqueues
//       (chat_message / silent_exit_comment), a 4xx does NOT (permanent),
//       a 5xx DOES (retryable), and `progress`-type chat heartbeats are
//       never buffered.
//   (d) crash-restart replay: instance B loads instance A's file and delivers
//       the buffered message through its sender.

import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate AGENT_MANAGER_HOME before dist imports (constants resolves at import).
process.env.AWB_AGENT_MANAGER_HOME = mkdtempSync(join(tmpdir(), 'awb-outbox-test-'));

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;

const { MessageOutbox, OUTBOX_MAX_AGE_MS } = await import('../dist/lib/outbox.js');
const {
  setRestOutbox,
  postChatRoomMessage,
  postSilentExitSystemComment,
  postDispatchAck,
  classifyHttpSendFailure,
} = await import('../dist/lib/rest.js');

const CONFIG = {
  url: 'http://awb.test:7701',
  apiKey: 'test-key',
  // Skip the silent-exit grace delay so tests don't pay real wall-clock time.
  silentExitVerifyDelayMs: 0,
};

function tmpOutboxPath(tag) {
  return join(mkdtempSync(join(tmpdir(), `awb-outbox-${tag}-`)), 'outbox.json');
}

// ── (pure) failure classification ────────────────────────────────────────────

test('classifyHttpSendFailure: 5xx/408/429 retryable, other 4xx permanent', () => {
  assert.equal(classifyHttpSendFailure(500), 'retryable');
  assert.equal(classifyHttpSendFailure(503), 'retryable');
  assert.equal(classifyHttpSendFailure(408), 'retryable');
  assert.equal(classifyHttpSendFailure(429), 'retryable');
  assert.equal(classifyHttpSendFailure(400), 'permanent');
  assert.equal(classifyHttpSendFailure(401), 'permanent');
  assert.equal(classifyHttpSendFailure(404), 'permanent');
});

// ── (a) persist / load round-trip ────────────────────────────────────────────

test('enqueue persists to disk and a fresh instance rehydrates FIFO order', () => {
  const path = tmpOutboxPath('roundtrip');
  const a = new MessageOutbox({ persistPath: path });
  a.enqueue('chat_message', { room_id: 'r1', agent_id: 'ag1', content: 'first', opts: null });
  a.enqueue('chat_message', { room_id: 'r1', agent_id: 'ag1', content: 'second', opts: null });
  assert.equal(a.size, 2);
  assert.ok(existsSync(path), 'outbox.json written');

  const b = new MessageOutbox({ persistPath: path });
  b.load();
  const snap = b.snapshot();
  assert.equal(snap.length, 2);
  assert.equal(snap[0].payload.content, 'first');
  assert.equal(snap[1].payload.content, 'second');
  assert.equal(snap[0].kind, 'chat_message');
});

test('load tolerates a malformed file (starts empty, does not throw)', () => {
  const path = tmpOutboxPath('corrupt');
  const a = new MessageOutbox({ persistPath: path });
  a.enqueue('command_ack', { command_id: 'c1', status: 'ok', detail: '' });
  // Corrupt it.
  writeFileSync(path, '{not json', 'utf8');
  const b = new MessageOutbox({ persistPath: path });
  b.load();
  assert.equal(b.size, 0);
});

// ── (b) flush semantics ──────────────────────────────────────────────────────

test('flush delivers FIFO, drops permanent, pauses on first retryable', async () => {
  const outbox = new MessageOutbox({ persistPath: null });
  const sent = [];
  const outcomes = ['ok', 'permanent', 'retryable', 'ok'];
  outbox.setSenders({
    chat_message: async (p) => {
      sent.push(p.content);
      return outcomes[Number(p.content)];
    },
  });
  for (let i = 0; i < 4; i++) {
    outbox.enqueue('chat_message', { room_id: 'r', agent_id: 'a', content: String(i), opts: null });
  }
  await outbox.flush('test');
  // 0 sent(ok), 1 sent(permanent→dropped), 2 sent(retryable→kept, pass stops).
  assert.deepEqual(sent, ['0', '1', '2']);
  assert.equal(outbox.size, 2, 'retryable entry and its tail are kept');
  assert.equal(outbox.snapshot()[0].payload.content, '2');
  assert.equal(outbox.snapshot()[0].attempts, 1, 'retryable increments attempts');

  // Server "recovers" — everything drains.
  outcomes[2] = 'ok';
  await outbox.flush('test2');
  assert.deepEqual(sent, ['0', '1', '2', '2', '3']);
  assert.equal(outbox.size, 0);
});

test('flush drops expired entries without calling the sender', async () => {
  let nowMs = 1_000_000;
  const outbox = new MessageOutbox({ persistPath: null, now: () => nowMs });
  const sent = [];
  outbox.setSenders({
    chat_message: async (p) => {
      sent.push(p.content);
      return 'ok';
    },
    dispatch_ack: async () => {
      sent.push('ack');
      return 'ok';
    },
  });
  outbox.enqueue('dispatch_ack', { body: { ticket_id: 't', role: 'assignee', trigger_id: 'x', outcome: 'processed' } });
  outbox.enqueue('chat_message', { room_id: 'r', agent_id: 'a', content: 'fresh', opts: null });
  // Advance past the dispatch_ack TTL but inside the chat TTL.
  nowMs += OUTBOX_MAX_AGE_MS.dispatch_ack + 1;
  await outbox.flush('test');
  assert.deepEqual(sent, ['fresh'], 'expired ack dropped unsent; fresh chat delivered');
  assert.equal(outbox.size, 0);
});

// ── (c) rest.ts wrapper integration ──────────────────────────────────────────

test('postChatRoomMessage buffers on network failure, skips progress type', async () => {
  const outbox = new MessageOutbox({ persistPath: null });
  setRestOutbox(outbox);
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  try {
    const ok = await postChatRoomMessage(CONFIG, 'room-1', 'agent-1', 'hello there');
    assert.equal(ok, false);
    assert.equal(outbox.size, 1, 'network failure buffered');
    assert.equal(outbox.snapshot()[0].kind, 'chat_message');
    assert.equal(outbox.snapshot()[0].payload.content, 'hello there');

    await postChatRoomMessage(CONFIG, 'room-1', 'agent-1', 'tool tick', { type: 'progress' });
    assert.equal(outbox.size, 1, 'progress heartbeat NOT buffered');
  } finally {
    globalThis.fetch = orig;
    setRestOutbox(null);
  }
});

test('postChatRoomMessage buffers on 5xx but not on 4xx', async () => {
  const outbox = new MessageOutbox({ persistPath: null });
  setRestOutbox(outbox);
  const orig = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('err', { status: 404, statusText: 'Not Found' });
    await postChatRoomMessage(CONFIG, 'room-1', 'agent-1', 'gone room');
    assert.equal(outbox.size, 0, '4xx is permanent — not buffered');

    globalThis.fetch = async () => new Response('err', { status: 503, statusText: 'Unavailable' });
    await postChatRoomMessage(CONFIG, 'room-1', 'agent-1', 'retry me');
    assert.equal(outbox.size, 1, '5xx is retryable — buffered');
  } finally {
    globalThis.fetch = orig;
    setRestOutbox(null);
  }
});

test('postSilentExitSystemComment and postDispatchAck buffer on network failure', async () => {
  const outbox = new MessageOutbox({ persistPath: null });
  setRestOutbox(outbox);
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('fetch failed');
  };
  try {
    const result = await postSilentExitSystemComment(CONFIG, 'ticket-1', {
      content: 'subagent exited silently',
      exit_code: 1,
    });
    assert.equal(result, 'failed', 'live caller still sees the failure');
    await postDispatchAck(CONFIG, {
      ticket_id: 'ticket-1',
      role: 'assignee',
      trigger_id: 'trig-1',
      outcome: 'processed',
      skill_snapshot_run_id: 'run-snapshot-1',
    });
    const snapshot = outbox.snapshot();
    const kinds = snapshot.map((e) => e.kind);
    assert.deepEqual(kinds, ['silent_exit_comment', 'dispatch_ack']);
    assert.equal(
      snapshot[1].payload.body.skill_snapshot_run_id,
      'run-snapshot-1',
      'skill snapshot ownership survives buffering',
    );
  } finally {
    globalThis.fetch = orig;
    setRestOutbox(null);
  }
});

// ── (d) crash-restart replay ─────────────────────────────────────────────────

test('a message buffered before death is replayed by the next boot instance', async () => {
  const path = tmpOutboxPath('restart');

  // Lifetime 1: live send fails while the server is down → buffered to disk.
  const first = new MessageOutbox({ persistPath: path });
  setRestOutbox(first);
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('server down');
  };
  try {
    await postChatRoomMessage(CONFIG, 'room-9', 'agent-9', 'survived the crash', {
      metadata: { ticket_refs: [{ id: 'abc' }] },
    });
  } finally {
    globalThis.fetch = orig;
    setRestOutbox(null);
  }
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).entries.length, 1);

  // Lifetime 2 ("restarted manager"): rehydrate + flush on SSE connect.
  const delivered = [];
  const second = new MessageOutbox({ persistPath: path });
  second.setSenders({
    chat_message: async (p) => {
      delivered.push({ room: p.room_id, content: p.content, opts: p.opts });
      return 'ok';
    },
  });
  second.load();
  assert.equal(second.size, 1);
  await second.flush('sse_connect');
  assert.equal(second.size, 0);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].room, 'room-9');
  assert.equal(delivered[0].content, 'survived the crash');
  assert.deepEqual(delivered[0].opts.metadata.ticket_refs, [{ id: 'abc' }], 'metadata survives the round-trip');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).entries.length, 0, 'drained queue persisted');
});
