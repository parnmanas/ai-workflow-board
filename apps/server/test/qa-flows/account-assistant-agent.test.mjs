import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp } from '../helpers/boot.mjs';
import { createAccount, createUser } from '../helpers/fixtures.mjs';
import { AccountsController } from '../../dist/modules/accounts/accounts.controller.js';

test('account updates no longer persist a saved assistant Agent binding', async (t) => {
  const { app, modules } = await bootApp({ port: 0 });
  t.after(() => { void app.close().catch(() => {}); });
  const ds = app.get(modules.getDataSourceToken());
  const owner = await createUser(app, modules.getDataSourceToken, { name: 'Owner', role: 'user' });
  const ws = await createAccount(app, modules.getDataSourceToken, 'without-assistant');
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  await app.get(AccountsController).update(ws.id, { name: 'Renamed', assistant_agent_id: 'retired', max_concurrent_tickets_per_agent: 3 }, res,
    { ...owner, permissions: [] });
  assert.equal(res.statusCode, 200);
  const stored = await ds.getRepository('Account').findOneByOrFail({ id: ws.id });
  assert.equal(stored.name, ws.name, 'work defaults do not rename the owning account');
  assert.equal(stored.max_concurrent_tickets_per_agent, 3);
  assert.equal(stored.assistant_agent_id, undefined);
  assert.equal(res.body.assistant_agent_id, undefined);
  assert.equal(await ds.createQueryRunner().hasColumn('accounts', 'assistant_agent_id'), false);
});
