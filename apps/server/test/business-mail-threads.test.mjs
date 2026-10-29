import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAccount, createUser } from './helpers/fixtures.mjs';
import { encrypt, decryptStrict } from '../dist/services/encryption.service.js';
import { reencryptRowForImport } from '../dist/modules/migration/migration-crypto.js';
import { BusinessMailService } from '../dist/modules/business/business-mail.service.js';
import { MAIL_CONNECTORS } from '../dist/modules/business/mail/mail-registry.js';
import { mailIds, mailReferenceChain, mailSubjectBase } from '../dist/modules/business/mail/mail-headers.js';

test('mail headers: ids, trimmed reference chains and reply/forward subjects', () => {
  assert.deepEqual(mailIds('<a@x> <b@x>\r\n <a@x>'), ['<a@x>', '<b@x>']);
  assert.deepEqual(mailIds(['a@x', '<b@x>']), ['<a@x>', '<b@x>'], 'JMAP returns bare ids');
  assert.deepEqual(mailIds('not an id'), []);
  const long = Array.from({ length: 40 }, (_, i) => `<r${i}@x>`);
  const chain = mailReferenceChain(long);
  assert.equal(chain.length, 30); assert.equal(chain[0], '<r0@x>', 'the conversation root survives trimming'); assert.equal(chain.at(-1), '<r39@x>');
  assert.deepEqual(mailSubjectBase('RE: Fwd: 회신: Re[2]: Quote  request'), { base: 'quote request', prefixed: true });
  assert.deepEqual(mailSubjectBase('Resume review'), { base: 'resume review', prefixed: false });
  assert.deepEqual(mailSubjectBase('[Fwd] 전달: Invoice'), { base: 'invoice', prefixed: true });
});

test('Business mail conversations group replies and forwards across inbound and outbound mail', { timeout: 120000 }, async t => {
  const { app, port, modules } = await bootApp(); t.after(() => closeTestApp(app));
  const ds = app.get(modules.getDataSourceToken()); const service = app.get(BusinessMailService); service.onModuleDestroy();
  const owner = await createUser(app, modules.getDataSourceToken, { name: 'Thread owner', role: 'admin' });
  const stranger = await createUser(app, modules.getDataSourceToken, { name: 'Thread stranger', role: 'admin' });
  const mine = await createAccount(app, modules.getDataSourceToken, 'threads', { ownerUserId: owner.id });
  const foreign = await createAccount(app, modules.getDataSourceToken, 'threads-foreign', { ownerUserId: stranger.id });
  const tokens = new Map([owner, stranger].map(u => [u.id, app.get(modules.AuthService).createSession(u.id)]));
  const http = async (path, { body, user = owner, account = mine.id } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/api${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${tokens.get(user.id)}`, 'X-Account-Id': account, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  const key = await ds.getRepository('Credential').save({ account_id: mine.id, name: 'mail', provider: 'mail', agent_env: false, encrypted_data: encrypt(JSON.stringify({ smtp_password: 's', imap_password: 'i' })) });
  const foreignKey = await ds.getRepository('Credential').save({ account_id: foreign.id, name: 'mail', provider: 'mail', agent_env: false, encrypted_data: encrypt(JSON.stringify({ smtp_password: 's', imap_password: 'i' })) });
  const input = credential => ({ name: 'Sales', provider: 'smtp_imap', credential_id: credential.id, purpose: 'general',
    config: { addresses: ['sales@example.com'], smtp: { host: 'smtp.example.com', port: 587, tls: 'starttls', username: 'sales' }, imap: { host: 'imap.example.com', port: 993, tls: 'implicit', username: 'sales', folder: 'INBOX' } } });
  const connection = await service.configure([mine.id], input(key));
  const foreignConnection = await service.configure([foreign.id], input(foreignKey));
  const connector = MAIL_CONNECTORS.find(c => c.descriptor.id === 'smtp_imap');
  let feed = []; let uid = 0; const sent = [];
  t.mock.method(connector, 'sync', async () => ({ messages: feed, cursor: { last_uid: uid } }));
  t.mock.method(connector, 'send', async (_ctx, content) => { sent.push(content); });
  // Collection time decides list order; SQLite stores it in seconds, so each mail gets its own minute.
  const minute = 60_000; let clock = Date.now() - 120 * minute;
  const stamp = (id, at) => ds.getRepository('BusinessMailMessage').update({ id }, { created_at: new Date(at) });
  const arrive = async (patch, accountId = mine.id, connectionId = connection.id) => {
    uid++; clock += minute;
    feed = [{ source_id: `v:${uid}`, message_id: `<m${uid}@vendor.example.org>`, from: 'vendor@vendor.example.org', to: ['sales@example.com'], subject: 'Quote',
      text: `message ${uid}`, date: new Date(clock).toISOString(), attachments: [], ...patch }];
    await service.sync([accountId], connectionId);
    const row = (await service.list([accountId], { limit: 100 })).messages.find(m => m.source_id === `v:${uid}`);
    await stamp(row.id, clock); return row;
  };
  const send = async body => {
    const row = await service.send([mine.id], connection.id, { request_id: randomUUID(), from: 'sales@example.com', confirm: true, ...body }, owner.id);
    clock = Math.max(clock + minute, Date.parse(row.date)); await stamp(row.id, clock); return row;
  };
  const threadOf = async id => (await ds.getRepository('BusinessMailMessage').findOneByOrFail({ id })).thread_key;

  // A first sync is history import (no automation); everything below exercises grouping only.
  const a = await arrive({ message_id: '<root@vendor.example.org>', subject: 'Quote request', attachments: [{ name: 'spec.pdf', type: 'application/pdf', size: 10 }] });
  const ours = await send({ to: ['vendor@vendor.example.org'], subject: 'Re: Quote request', text: 'Thanks, attached.', reply_to_message_id: a.id });
  let c, d, e, f, g;
  await t.test('References, In-Reply-To and a forwarded body join one conversation; a bare same subject does not', async () => {
    assert.equal(sent[0].in_reply_to, '<root@vendor.example.org>'); assert.deepEqual(sent[0].references, ['<root@vendor.example.org>']);
    assert.equal(await threadOf(ours.id), await threadOf(a.id));
    // Replied from another mail client (not collected): the unknown parent is skipped, the References root decides.
    c = await arrive({ subject: 'RE: Re: Quote request', in_reply_to: '<webmail-reply@example.com>', references: ['<root@vendor.example.org>', '<webmail-reply@example.com>'] });
    // Only In-Reply-To pointing at our sent reply.
    d = await arrive({ subject: 'Re: Quote request', in_reply_to: sent[0].message_id });
    // A forward without headers from a colleague: same subject and the original party quoted in the body.
    e = await arrive({ from: 'colleague@partner.example.net', subject: 'Fwd: Quote request', text: '---------- Forwarded message ---------\nFrom: vendor@vendor.example.org\nSubject: Quote request' });
    // Same subject, unrelated people, no headers: a different conversation.
    f = await arrive({ from: 'someone@else.example.net', subject: 'Re: Quote request', text: 'Unrelated' });
    // No reply marker and no headers: a new conversation even from the same sender.
    g = await arrive({ subject: 'Quote request' });
    const root = await threadOf(a.id);
    for (const row of [c, d, e]) assert.equal(await threadOf(row.id), root, row.subject);
    for (const row of [f, g]) assert.notEqual(await threadOf(row.id), root, row.subject);
    assert.notEqual(await threadOf(f.id), await threadOf(g.id));
    const raw = await ds.getRepository('BusinessMailMessage').findOneByOrFail({ id: a.id });
    assert.ok(raw.thread_key && !raw.thread_key.includes('root'), 'conversation keys are keyed digests, not headers');
  });

  await t.test('a reply collected before its parent is merged when the parent arrives', async () => {
    const early = await arrive({ subject: 'Re: Delivery date', in_reply_to: '<late@vendor.example.org>' });
    const late = await arrive({ message_id: '<late@vendor.example.org>', subject: 'Re: Quote request', in_reply_to: '<root@vendor.example.org>' });
    assert.equal(await threadOf(late.id), await threadOf(a.id));
    assert.equal(await threadOf(early.id), await threadOf(a.id));
  });

  await t.test('conversation list: newest activity first, summary covers every mail, filters match any mail, pages count conversations', async () => {
    const all = await http('/business/mail/messages?view=threads');
    assert.equal(all.status, 200);
    assert.equal(all.data.view, 'threads'); assert.equal(all.data.total, 3);
    const [latest, ...rest] = all.data.threads;
    assert.equal(latest.count, 7); assert.equal(latest.outbound, 1); assert.equal(latest.inbound, 6); assert.equal(latest.unconfirmed, 6);
    assert.equal(latest.subject, 'Quote request', 'the original subject');
    assert.equal(latest.senders[0], 'vendor@vendor.example.org'); assert.ok(latest.senders.includes('sales@example.com')); assert.ok(latest.senders.includes('colleague@partner.example.net'));
    assert.equal(latest.attachments, 1); assert.deepEqual(latest.connection_ids, [connection.id]);
    assert.equal(latest.preview, 'message 8'); assert.equal(latest.latest_id, (await http('/business/mail/messages?limit=1')).data.messages[0].id);
    assert.deepEqual(rest.map(r => r.count), [1, 1]);
    assert.doesNotMatch(JSON.stringify(all.data), /thread_key|message_key|subject_key|encrypted_data/);
    const outbound = await http('/business/mail/messages?view=threads&direction=outbound');
    assert.equal(outbound.data.total, 1); assert.equal(outbound.data.threads[0].count, 7);
    const page = await http('/business/mail/messages?view=threads&limit=1&offset=1');
    assert.equal(page.data.total, 3); assert.equal(page.data.threads.length, 1); assert.equal(page.data.threads[0].id, rest[0].id);
    assert.equal((await http('/business/mail/messages')).data.total, 9, 'the mail-by-mail view is unchanged');
    const theirs = await http('/business/mail/messages?view=threads', { user: stranger, account: foreign.id });
    assert.equal(theirs.data.total, 0);
  });

  await t.test('opening a mail with thread=1 returns its conversation oldest first, owner-scoped', async () => {
    const detail = await http(`/business/mail/messages/${c.id}?thread=1`);
    assert.equal(detail.status, 200); assert.equal(detail.data.id, c.id);
    assert.equal(detail.data.thread.total, 7);
    assert.equal(detail.data.thread.messages[0].id, a.id); assert.equal(detail.data.thread.messages[1].id, ours.id);
    assert.equal(detail.data.thread.messages[1].text, 'Thanks, attached.');
    assert.ok(detail.data.thread.messages.every(m => 'reply' in m));
    assert.equal((await http(`/business/mail/messages/${c.id}`)).data.thread, undefined);
    assert.equal((await http(`/business/mail/messages/${c.id}?thread=1`, { user: stranger, account: foreign.id })).status, 404);
  });

  await t.test('forwarding keeps the conversation without replying; a direct reply cancels a pending agent draft', async () => {
    await assert.rejects(service.send([mine.id], connection.id, { request_id: randomUUID(), from: 'sales@example.com', to: ['boss@example.com'], subject: 'Fwd: Quote request', text: 'FYI', reply_to_message_id: c.id, forward_message_id: c.id, confirm: true }, owner.id), /하나만/);
    await assert.rejects(service.send([mine.id], connection.id, { request_id: randomUUID(), from: 'sales@example.com', to: ['boss@example.com'], subject: 'Fwd', text: 'FYI', forward_message_id: (await arrive({}, foreign.id, foreignConnection.id)).id, confirm: true }, owner.id), /찾을 수 없/);
    const forward = await send({ to: ['boss@example.com'], subject: 'Fwd: Quote request', text: 'FYI', forward_message_id: c.id });
    const content = sent.at(-1);
    assert.equal(content.in_reply_to, undefined);
    assert.deepEqual(content.references, ['<root@vendor.example.org>', '<webmail-reply@example.com>', `<m${c.source_id.split(':')[1]}@vendor.example.org>`]);
    assert.equal(await threadOf(forward.id), await threadOf(a.id));
    // Live arrivals got automation tasks (skipped: automation is off); put them in the states under test.
    const tasks = ds.getRepository('BusinessMailTask');
    await tasks.update({ message_id: d.id }, { status: 'review', review_notification_state: 'pending', revision: 0 });
    await tasks.update({ message_id: e.id }, { status: 'sent' });
    await send({ to: ['vendor@vendor.example.org'], subject: 'Re: Quote request', text: 'Answered by hand', reply_to_message_id: d.id });
    await send({ to: ['vendor@vendor.example.org'], subject: 'Re: Quote request', text: 'Again', reply_to_message_id: e.id });
    const cancelled = await tasks.findOneByOrFail({ message_id: d.id });
    assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.review_notification_state, 'none'); assert.equal(cancelled.revision, 1);
    assert.equal((await tasks.findOneByOrFail({ message_id: e.id })).status, 'sent', 'finished replies are history');
  });

  await t.test('mail without keys (collected before conversations, or imported) is grouped again by the backfill', async () => {
    const repo = ds.getRepository('BusinessMailMessage');
    const before = await repo.find({ where: { account_id: mine.id }, order: { created_at: 'ASC', id: 'ASC' } });
    const groups = rows => { const ids = new Map(); return rows.map(r => { if (!ids.has(r.thread_key)) ids.set(r.thread_key, ids.size); return ids.get(r.thread_key); }); };
    const imported = reencryptRowForImport('BusinessMailMessage', { ...before[0], encrypted_data: decryptStrict(before[0].encrypted_data) });
    assert.deepEqual([imported.message_key, imported.thread_key, imported.subject_key], ['', '', '']);
    await repo.createQueryBuilder().update().set({ message_key: '', thread_key: '', subject_key: '' }).execute();
    const pending = await http('/business/mail/messages?view=threads&limit=100');
    assert.equal(pending.data.total, before.length, 'unkeyed mail stays listed, one conversation each');
    assert.ok(await service.backfillThreads() >= before.length);
    const after = await repo.find({ where: { account_id: mine.id }, order: { created_at: 'ASC', id: 'ASC' } });
    assert.deepEqual(groups(after), groups(before));
    assert.equal(await service.backfillThreads(), 0);
  });
});
