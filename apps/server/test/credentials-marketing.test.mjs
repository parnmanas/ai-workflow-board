import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { DataSource } from 'typeorm';
import { Credential } from '../dist/entities/Credential.js';
import { Resource } from '../dist/entities/Resource.js';
import { Project } from '../dist/entities/Project.js';
import { AgentSessionExecution } from '../dist/entities/AgentSessionExecution.js';
import { AgentSessionCliSetting } from '../dist/entities/AgentSessionCliSetting.js';
import { OutreachChannel } from '../dist/entities/OutreachChannel.js';
import { MarketingCampaign } from '../dist/entities/MarketingCampaign.js';
import { MarketingChannel } from '../dist/entities/MarketingChannel.js';
import { MarketingSpendRequest } from '../dist/entities/MarketingSpendRequest.js';
import { CredentialsController } from '../dist/modules/credentials/credentials.controller.js';
import { encrypt, decrypt } from '../dist/services/encryption.service.js';

const entities = [Credential, Resource, Project, AgentSessionExecution, AgentSessionCliSetting, OutreachChannel,
  MarketingCampaign, MarketingChannel, MarketingSpendRequest];
const req = { currentUser: { id: 'admin', name: 'Admin', role: 'admin', permissions: [] } };
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
let db, controller, credential;
before(async () => {
  db = await new DataSource({ type: 'sqljs', entities, synchronize: true }).initialize();
  controller = new CredentialsController(db.getRepository(Credential), db, {}, { logActivity: async () => {} }, {}, {});
});
after(async () => { await db?.destroy(); });
beforeEach(async () => {
  for (const entity of entities) await db.getRepository(entity).clear();
  credential = await db.getRepository(Credential).save({ name: 'Key', provider: 'custom', account_id: null,
    encrypted_data: encrypt(JSON.stringify({ token: 'old-secret' })) });
});
async function campaign(fields = {}) {
  return db.getRepository(MarketingCampaign).save({ account_id: 'a', name: 'Private campaign', slug: 'test', ...fields });
}
async function channel(id) {
  return db.getRepository(MarketingChannel).save({ account_id: 'a', campaign_id: 'campaign', platform: 'email',
    kind: 'email', name: 'Private channel', target: 'list', target_key: 'list', config: { credential_id: id } });
}
async function payment(status = 'unknown', returnStatus = '') {
  return db.getRepository(MarketingSpendRequest).save({ account_id: 'a', campaign_id: 'campaign', channel_id: '',
    amount_minor: 100, currency: 'KRW', payee: 'Vendor', purpose: 'Test', provider: 'stripe_issuing',
    provider_credential_id: credential.id, payload_sha256: 'hash', status, return_status: returnStatus,
    expires_at: new Date(Date.now() + 60000) });
}
for (const [label, seed] of [
  ['webhook', () => campaign({ payment_credential_id: credential.id })],
  ...['meta_ads', 'google_ads', 'stripe_issuing'].map(provider => [provider, () => campaign({ payees: [{ name: 'Vendor', provider, credential_id: credential.id }] })]),
  ['email', () => channel(credential.id)],
  ['open payment snapshot', () => payment()],
  ['open return', () => payment('paid', 'unknown')],
]) {
  test(`${label}: deletion, narrowing outside owner and agent exposure are refused without writes`, async () => {
    await seed();
    for (const patch of [{ scope: 'account', account_id: 'b' }, { agent_env: true, name: 'Must not persist', credentials: { token: 'new' } }]) {
      const res = response();
      await controller.update(credential.id, patch, req, res);
      assert.equal(res.statusCode, 409, JSON.stringify(res.body));
      assert.match(res.body.error, /marketing/);
      assert.doesNotMatch(res.body.error, /Private|old-secret/);
      const stored = await db.getRepository(Credential).findOneByOrFail({ id: credential.id });
      assert.equal(stored.account_id, null);
      assert.equal(stored.agent_env, false);
      assert.equal(stored.name, 'Key');
      assert.deepEqual(JSON.parse(decrypt(stored.encrypted_data)), { token: 'old-secret' });
    }
    const res = response();
    await controller.remove(credential.id, undefined, req, res);
    assert.equal(res.statusCode, 409);
    assert.ok(await db.getRepository(Credential).findOneBy({ id: credential.id }));
    const sameOwner = response();
    await controller.update(credential.id, { scope: 'account', account_id: 'a' }, req, sameOwner);
    assert.equal(sameOwner.statusCode, 200);
  });
}
test('exact JSON ID matching ignores substrings, notes and unrelated keys', async () => {
  await campaign({ payees: [{ name: credential.id, credential_id: `${credential.id}-other` }] });
  await channel(`${credential.id}-other`);
  const res = response();
  await controller.update(credential.id, { scope: 'account', account_id: 'b', agent_env: true }, req, res);
  assert.equal(res.statusCode, 200);
  const removed = response();
  await controller.remove(credential.id, 'b', req, removed);
  assert.equal(removed.statusCode, 200);
});
test('secret rotation warns about open requests; masked/no-op edits do not', async () => {
  await payment();
  for (const patch of [{ name: 'Renamed' }, { credentials: { token: '••••' } }, { credentials: { token: 'old-secret' } }]) {
    const res = response();
    await controller.update(credential.id, patch, req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.warnings, undefined);
  }
  const res = response();
  await controller.update(credential.id, { credentials: { token: 'new-secret' } }, req, res);
  assert.equal(res.statusCode, 200);
  assert.match(res.body.warnings[0], /1 open marketing payment request/);
  assert.doesNotMatch(res.body.warnings[0], /secret|Vendor/);
});
test('closed requests do not block deletion or warn on rotation', async () => {
  await payment('failed');
  const res = response();
  await controller.update(credential.id, { credentials: { token: 'new-secret' } }, req, res);
  assert.equal(res.body.warnings, undefined);
  const removed = response();
  await controller.remove(credential.id, undefined, req, removed);
  assert.equal(removed.statusCode, 200);
});
