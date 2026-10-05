import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexAsyncQuestion, watchCodexAsyncQuestions } from '../dist/lib/clis/codex/async-questions.js';

const record = (id = 'call-question') => ({ type: 'event_msg', payload: { type: 'item_completed', item: {
  type: 'AgentMessage', id, delivery: 'async', questions: [{ title: '어떤 설명을 먼저 듣고 싶으세요?', options: ['짧은 요약', '자세한 설명'] }],
} } });

test('native async messages become selectable questions, ordinary messages stay ordinary', () => {
  const question = codexAsyncQuestion(record());
  assert.equal(question.id, 'call-question');
  assert.deepEqual(question.schema.properties.q_1.oneOf.map((v) => v.const), ['짧은 요약', '자세한 설명', '__other__']);
  assert.deepEqual(question.schema.required, ['q_1']);
  assert.equal(codexAsyncQuestion({ ...record(), type: 'response_item' }), null);
  const ordinary = record();
  delete ordinary.payload.item.delivery;
  assert.equal(codexAsyncQuestion(ordinary), null);
});

test('watcher reads newly appended native questions once, including split UTF-8 writes; close stops it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-codex-questions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'rollout.jsonl');
  await writeFile(path, JSON.stringify(record('old')) + '\n');
  const received = [];
  const watcher = await watchCodexAsyncQuestions(async () => path, (q) => received.push(q));
  t.after(() => watcher.close());
  await watcher.poll();
  assert.deepEqual(received, [], 'resuming does not repeat a previous question');
  const bytes = Buffer.from(JSON.stringify(record()) + '\n');
  const split = bytes.indexOf(Buffer.from('어')) + 1;
  await appendFile(path, bytes.subarray(0, split));
  await watcher.poll();
  assert.equal(received.length, 0);
  await appendFile(path, bytes.subarray(split));
  await watcher.poll();
  assert.equal(received[0].message, '어떤 설명을 먼저 듣고 싶으세요?');
  await appendFile(path, bytes);
  await watcher.poll();
  assert.equal(received.length, 1, 'duplicate completed items do not ask twice');
  watcher.close();
  await appendFile(path, JSON.stringify(record('after-close')) + '\n');
  await watcher.poll();
  assert.equal(received.length, 1);
});

test('watcher finds the rollout created after session/new', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-codex-questions-new-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let path = null;
  const received = [];
  const watcher = await watchCodexAsyncQuestions(async () => path, (q) => received.push(q));
  t.after(() => watcher.close());
  await watcher.poll();
  path = join(root, 'rollout.jsonl');
  await writeFile(path, JSON.stringify(record()) + '\n');
  await watcher.poll();
  assert.equal(received.length, 1);
});
