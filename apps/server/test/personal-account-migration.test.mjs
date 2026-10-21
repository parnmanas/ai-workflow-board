import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../dist/db.js';
import { PersonalAccountOwnership1760000000095 } from '../dist/database/migrations/1760000000095-PersonalAccountOwnership.js';
import { INSTANCE_CONTEXT_ID } from '../dist/common/instance-context.js';
import { ensurePersonalAccount } from '../dist/common/personal-account.js';

async function fixture(t) {
  const ds = new DataSource({ type: 'sqljs', entities: buildDataSourceOptions().entities, synchronize: true, autoSave: false });
  await ds.initialize();
  t.after(() => ds.destroy());
  const save = (name, value) => ds.getRepository(name).save(ds.getRepository(name).create(value));
  await save('Account', { id: INSTANCE_CONTEXT_ID, name: 'Instance defaults', knowledge_memory: 'keep memory' });
  return { ds, save };
}
async function migrate(ds, ownerId) {
  const previous = process.env.AWB_LEGACY_OWNER_USER_ID;
  if (ownerId) process.env.AWB_LEGACY_OWNER_USER_ID = ownerId;
  else delete process.env.AWB_LEGACY_OWNER_USER_ID;
  const runner = ds.createQueryRunner();
  await runner.startTransaction();
  try {
    await new PersonalAccountOwnership1760000000095().up(runner);
    await runner.commitTransaction();
  } catch (e) {
    await runner.rollbackTransaction();
    throw e;
  } finally {
    if (previous === undefined) delete process.env.AWB_LEGACY_OWNER_USER_ID;
    else process.env.AWB_LEGACY_OWNER_USER_ID = previous;
    await runner.release();
  }
}

test('fresh installation has no unowned default account', async t => {
  const { ds } = await fixture(t);
  await migrate(ds);
  assert.equal(await ds.getRepository('Account').count(), 0);
});

test('legacy attribution needs an explicit active user and rolls back on failure', async t => {
  const { ds, save } = await fixture(t);
  const user = await save('User', { name: 'pending', status: 'pending' });
  await assert.rejects(migrate(ds), /AWB_LEGACY_OWNER_USER_ID/);
  await assert.rejects(migrate(ds, user.id), /active login user/);
  assert.equal((await ds.getRepository('Account').findOneByOrFail({ id: INSTANCE_CONTEXT_ID })).owner_user_id, null);
});

test('assigns all old work to the selected owner, preserves content and explicit builtin Global definitions', async t => {
  const { ds, save } = await fixture(t);
  const parn = await save('User', { name: 'Parn', status: 'active', role: 'admin' });
  const kent = await save('User', { name: 'kent.k', status: 'active', role: 'user' });
  const credential = await save('Credential', { name: 'private login', provider: 'codex', encrypted_data: 'ciphertext-do-not-rewrite' });
  const host = await save('RuntimeHost', { name: 'Rolf', account_id: INSTANCE_CONTEXT_ID, is_active: 1 });
  const ticket = await save('Ticket', { title: 'Legacy NULL owner', account_id: null });
  const builtin = await save('Skill', { name: 'Builtin', slug: 'builtin', source_kind: 'builtin' });
  const custom = await save('Skill', { name: 'Custom', slug: 'custom', source_kind: 'local' });
  const fn = await save('WorkflowFunction', { name: 'Builtin function', key: 'builtin', builtin: true });
  const customFn = await save('WorkflowFunction', { name: 'Private function', key: 'custom', builtin: false });
  const before = await ds.getRepository('Credential').findOneByOrFail({ id: credential.id });
  await migrate(ds, parn.id);
  const accounts = await ds.getRepository('Account').find();
  assert.equal(accounts.length, 2);
  const pa = accounts.find(row => row.owner_user_id === parn.id);
  const ka = accounts.find(row => row.owner_user_id === kent.id);
  assert.equal(pa.id, INSTANCE_CONTEXT_ID);
  assert.equal(pa.name, 'Parn');
  assert.equal(pa.knowledge_memory, 'keep memory');
  assert.notEqual(ka.id, pa.id);
  assert.equal(ka.knowledge_memory, '');
  assert.deepEqual({ ...await ds.getRepository('Credential').findOneByOrFail({ id: credential.id }) }, { ...before, account_id: pa.id });
  assert.equal((await ds.getRepository('RuntimeHost').findOneByOrFail({ id: host.id })).account_id, pa.id);
  assert.equal((await ds.getRepository('Ticket').findOneByOrFail({ id: ticket.id })).account_id, pa.id);
  for (const [name, id, owner] of [['Skill', builtin.id, null], ['Skill', custom.id, pa.id], ['WorkflowFunction', fn.id, null], ['WorkflowFunction', customFn.id, pa.id]]) {
    assert.equal((await ds.getRepository(name).findOneByOrFail({ id })).account_id, owner);
  }
  const newTicket = await save('Ticket', { title: 'Kent new work', account_id: ka.id });
  await migrate(ds, parn.id);
  assert.equal((await ds.getRepository('Ticket').findOneByOrFail({ id: newTicket.id })).account_id, ka.id, 'replay cannot reassign later work');
  const same = await Promise.all(Array.from({ length: 10 }, () => ensurePersonalAccount(ds.manager, kent)));
  assert.ok(same.every(row => row.id === ka.id));
});
