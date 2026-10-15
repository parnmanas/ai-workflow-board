import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentSessionDelivery } from '../dist/lib/agent-session-delivery.js';

const event = (seq, text = 'output') => ({ id: `session:live:${seq}`, seq, type: 'text', payload: { text } });

test('slow transport batches queued output without reordering or advancing the finished state', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const sent = [];
  const queue = new AgentSessionDelivery(async (events, state) => {
    sent.push({ events, state });
    if (sent.length === 1) await gate;
  });
  queue.enqueue([event(0)], { status: 'busy' });
  await Promise.resolve();
  for (let i = 1; i <= 1000; i++) queue.enqueue([event(i)]);
  const done = queue.enqueue([], { status: 'ready' });
  assert.equal(sent.length, 1, 'no overlapping requests or premature final state');
  release();
  await done;
  assert.equal(sent.length, 10, '1000 queued output requests become eight bounded batches');
  assert.deepEqual(sent.flatMap((b) => b.events.map((e) => e.seq)), Array.from({ length: 1001 }, (_, i) => i));
  assert.ok(sent.every((b) => b.events.length <= 128));
  assert.deepEqual(sent.at(-1), { events: [], state: { status: 'ready' } });
});

test('permission and other state transitions remain separate ordered boundaries', async () => {
  const sent = [];
  const queue = new AgentSessionDelivery(async (events, state) => { sent.push({ events, state }); });
  queue.enqueue([event(1)]);
  queue.enqueue([event(2)], { status: 'awaiting_permission' });
  queue.enqueue([], { status: 'busy' });
  queue.enqueue([event(3)]);
  await queue.enqueue([event(4)]);
  assert.deepEqual(sent.map((b) => [b.events.map((e) => e.seq), b.state?.status]), [
    [[1], undefined], [[2], 'awaiting_permission'], [[], 'busy'], [[3, 4], undefined],
  ]);
});

test('batch byte budget counts UTF-8 bytes, not characters', async () => {
  const sent = [];
  const queue = new AgentSessionDelivery(async (events) => { sent.push(events); });
  queue.enqueue([event(1, '가'.repeat(100_000))]);
  await queue.enqueue([event(2, '가'.repeat(100_000))]);
  assert.equal(sent.length, 2);
  assert.ok(sent.every((events) => Buffer.byteLength(JSON.stringify(events)) < 512 * 1024));
});

test('a failed request does not wedge following state updates or the next drain', async () => {
  const sent = [];
  const queue = new AgentSessionDelivery(async (events, state) => {
    sent.push({ events, state });
    if (sent.length === 1) throw new Error('connection closed');
  });
  queue.enqueue([event(1)], { status: 'busy' });
  await queue.enqueue([event(2)], { status: 'ready' });
  await queue.enqueue([event(3)], { status: 'busy' });
  assert.deepEqual(sent.map((b) => b.state.status), ['busy', 'ready', 'busy']);
});
