import { it } from 'node:test';
import assert from 'node:assert/strict';
import { BuildSlots, buildConcurrency } from '../dist/modules/ontology/build-slots.js';

it('defaults invalid limits to one', () => {
  for (const value of [undefined, '', '0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992', '2workers']) {
    assert.equal(buildConcurrency(value), 1);
  }
  assert.equal(buildConcurrency('2'), 2);
});

it('allows configured concurrency and transfers slots in FIFO order without barging', async () => {
  const slots = new BuildSlots(2);
  const a = await slots.acquire();
  const b = await slots.acquire();
  const admitted = [];
  const third = slots.acquire().then((release) => { admitted.push(3); return release; });
  const fourth = slots.acquire().then((release) => { admitted.push(4); return release; });
  await Promise.resolve();
  assert.deepEqual(admitted, []);
  a();
  a(); // release is idempotent
  const fifth = slots.acquire().then((release) => { admitted.push(5); return release; });
  const c = await third;
  assert.deepEqual(admitted, [3]);
  b();
  const d = await fourth;
  assert.deepEqual(admitted, [3, 4]);
  c();
  const e = await fifth;
  assert.deepEqual(admitted, [3, 4, 5]);
  d();
  e();
});
