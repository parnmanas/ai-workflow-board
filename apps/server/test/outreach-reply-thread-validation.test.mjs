import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DataSource } from 'typeorm';
import { OutreachChannel } from '../dist/entities/OutreachChannel.js';
import { OutreachChannelService } from '../dist/modules/outreach/outreach-channel.service.js';
import { resolveChannelConnector } from '../dist/modules/outreach/connector-resolver.js';
import { encrypt } from '../dist/services/encryption.service.js';

process.env.ENCRYPTION_KEY = 'outreach-thread-validation-test';

async function fixture(t) {
  const db = await new DataSource({ type: 'sqljs', entities: [OutreachChannel], synchronize: true }).initialize();
  t.after(() => db.destroy());
  const repo = db.getRepository(OutreachChannel);
  const credentialRepo = { findOne: async ({ where }) => ({ id: where.id, account_id: 'account', encrypted_data: encrypt(JSON.stringify({ token: 'test', client_id: 'test', client_secret: 'test' })) }) };
  const service = new OutreachChannelService(repo, {}, credentialRepo, db, { computeNextPoll: () => new Date() });
  const input = { accountId: 'account', kind: 'reddit', name: 'channel', targets: ['Allowed'], credentialId: 'credential', deployPostMode: 'reply_to_existing', replyThreadRef: ' t3_thread ' };
  return { repo, service, input, credentialRepo };
}

test('create/update reject outside targets without persisting any part of a patch', async (t) => {
  const { repo, service, input } = await fixture(t);
  let target = 'elsewhere';
  let calls = 0;
  service.connectorFactory = async () => ({ describeThread: async () => { calls++; return { target }; } });
  await assert.rejects(service.create(input), { status: 400, message: /outside.*whitelist/ });
  assert.equal(await repo.count(), 0);
  target = 'allowed';
  const row = await service.create(input);
  assert.equal(row.reply_thread_ref, 't3_thread');
  for (const patch of [
    { targets: ['other'], name: 'must not save' },
    { replyThreadRef: 't3_other' }, { kind: 'github' }, { credentialId: 'other' },
  ]) {
    target = 'elsewhere';
    await assert.rejects(service.update(row.id, 'account', patch), { status: 400 });
    const stored = await repo.findOneByOrFail({ id: row.id });
    assert.equal(stored.name, 'channel');
    assert.equal(stored.reply_thread_ref, 't3_thread');
    assert.deepEqual(stored.targets, ['Allowed']);
    assert.equal(stored.kind, 'reddit');
    assert.equal(stored.credential_id, 'credential');
  }
  const previous = calls;
  await service.update(row.id, 'account', { name: 'renamed' });
  await service.update(row.id, 'account', { deployPostMode: 'off', credentialId: null });
  assert.equal(calls, previous);
  await assert.rejects(service.update(row.id, 'account', { deployPostMode: 'reply_to_existing' }), { status: 400 });
});

test('missing credentials and failed lookups reject; off mode can be saved; errors do not leak secrets', async (t) => {
  const { repo, service, input } = await fixture(t);
  await assert.rejects(service.create({ ...input, credentialId: null }), { status: 400, message: /Could not verify/ });
  await service.create({ ...input, credentialId: null, deployPostMode: 'off' });
  service.connectorFactory = async () => ({ describeThread: async () => { throw new Error('secret remote response'); } });
  await assert.rejects(service.create(input), (e) => e.status === 400 && !e.message.includes('secret'));
  assert.equal(await repo.count(), 1);
});

test('real GitHub connector checks repo whitelist without network calls', async (t) => {
  const { service, input } = await fixture(t);
  const github = { ...input, kind: 'github', targets: ['Owner/Repo'], replyThreadRef: 'issue:owner/repo#1' };
  await service.create(github);
  await assert.rejects(service.create({ ...github, replyThreadRef: 'issue:owner/other#1' }), { status: 400, message: /outside.*whitelist/ });
  await assert.rejects(service.create({ ...github, replyThreadRef: 'invalid' }), { status: 400 });
});

test('Reddit lookup consumes the saved channel shared hourly quota', async (t) => {
  const { service, input, credentialRepo } = await fixture(t);
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests++;
    return new Response(JSON.stringify(String(url).includes('access_token')
      ? { access_token: 'access', expires_in: 3600 }
      : { data: { children: [{ data: { subreddit: 'allowed' } }] } }), { status: 200 });
  });
  const row = await service.create({ ...input, rateLimitPerHour: 1 });
  assert.ok(row.id);
  const before = requests;
  const connector = await resolveChannelConnector(row, credentialRepo);
  await assert.rejects(connector.describeThread('t3_thread'), { code: 'channel_rate_limited' });
  assert.equal(requests, before);
  await assert.rejects(service.update(row.id, 'account', { replyThreadRef: 't3_another' }), { status: 400 });
  assert.equal((await service.get(row.id, 'account')).reply_thread_ref, 't3_thread');
});
