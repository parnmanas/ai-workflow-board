import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { smtpImapConnector } from '../dist/modules/business/mail/smtp-imap.connector.js';
import { jmapConnector } from '../dist/modules/business/mail/jmap.connector.js';
const require = createRequire(import.meta.url);
const network = require('../dist/modules/business/mail/mail-network.js');

test('mail targets block private DNS answers and rebinds, with explicit NAS allowlisting', async t => {
  const previous = process.env.AWB_MAIL_PRIVATE_HOSTS; delete process.env.AWB_MAIL_PRIVATE_HOSTS;
  t.after(() => { if (previous === undefined) delete process.env.AWB_MAIL_PRIVATE_HOSTS; else process.env.AWB_MAIL_PRIVATE_HOSTS = previous; });
  await assert.rejects(network.resolveMailHost('169.254.169.254'), /내부 메일/);
  await assert.rejects(network.resolveMailHost('mail.example.com', async () => [{ address: '8.8.8.8' }, { address: '127.0.0.1' }]), /내부 메일/);
  process.env.AWB_MAIL_PRIVATE_HOSTS = 'nas.example.com';
  assert.equal((await network.resolveMailHost('nas.example.com', async () => [{ address: '192.168.1.20' }])).address, '192.168.1.20');
  assert.throws(() => network.mailUrl('http://mail.example.com'), /HTTPS/);
  assert.throws(() => network.mailUrl('https://evil.example.com/api', 'https://mail.example.com'), /origin/);
});

test('IMAP uses read-only bounded UID collection, resets UIDVALIDITY and closes on failure', async t => {
  t.mock.method(network, 'resolveMailHost', async host => ({ host, address: '203.0.113.10' }));
  let range; let byUid; let closed = 0;
  // Use the CJS class used by compiled server code, not the separate ESM package entry.
  const client = require('imapflow').ImapFlow.prototype;
  t.mock.method(client, 'connect', async function() { assert.equal(this.options.logger, false); assert.equal(this.options.tls.rejectUnauthorized, true); });
  t.mock.method(client, 'mailboxOpen', async (_folder, options) => { assert.equal(options.readOnly, true); return { uidValidity: 10n, uidNext: 30, exists: 25 }; });
  t.mock.method(client, 'fetch', async function*(value, query, options) {
    range = value; byUid = options.uid; assert.equal(query.source.maxLength, 2000000);
    yield { uid: 29, size: 100, envelope: { from: [{ address: 'sender@example.com' }], to: [{ address: 'ops@example.com' }], subject: 'Hello', messageId: '<m@example.com>' }, source: Buffer.from('From: sender@example.com\r\nTo: ops@example.com\r\nSubject: Hello\r\nContent-Type: text/plain\r\n\r\nBody'), internalDate: new Date('2026-01-01') };
  });
  t.mock.method(client, 'close', () => { closed++; });
  const context = { config: { addresses: ['ops@example.com'], imap: { host: 'imap.example.com', port: 993, tls: 'implicit', username: 'ops', folder: 'INBOX' } }, secrets: { imap_password: 'secret' }, cursor: {} };
  const first = await smtpImapConnector.sync(context); assert.equal(range, '6:25'); assert.equal(byUid, false); assert.equal(first.messages[0].text, 'Body');
  assert.deepEqual(first.cursor, { uid_validity: '10', last_uid: 29 });
  await smtpImapConnector.sync({ ...context, cursor: { uid_validity: '10', last_uid: 24 } }); assert.equal(range, '25:29'); assert.equal(byUid, true);
  await smtpImapConnector.sync({ ...context, cursor: { uid_validity: '9', last_uid: 50 } }); assert.equal(byUid, false);
  assert.equal(closed, 3);
});

test('SMTP enforces TLS, safe content and stable Message-ID; partial recipients stay uncertain', async t => {
  t.mock.method(network, 'resolveMailHost', async host => ({ host, address: '203.0.113.10' }));
  let options; let payload;
  t.mock.method(require('nodemailer'), 'createTransport', value => { options = value; return { sendMail: async body => { payload = body; return { accepted: ['target@example.com'], rejected: [] }; }, close() {} }; });
  const config = { addresses: ['ops@example.com'], smtp: { host: 'smtp.example.com', port: 587, tls: 'starttls', username: 'ops' } };
  const message = { from: 'ops@example.com', to: ['target@example.com'], subject: 'Automation', text: 'Hello', message_id: '<stable@example.com>' };
  await smtpImapConnector.send({ config, secrets: { smtp_password: 'secret' }, cursor: {} }, message);
  assert.equal(options.requireTLS, true); assert.equal(options.tls.servername, 'smtp.example.com'); assert.equal(options.host, '203.0.113.10');
  assert.equal(options.disableFileAccess, true); assert.equal(options.disableUrlAccess, true); assert.equal(payload.messageId, '<stable@example.com>');
  t.mock.method(require('nodemailer'), 'createTransport', () => ({ sendMail: async () => ({ accepted: ['target@example.com'], rejected: ['other@example.com'] }), close() {} }));
  await assert.rejects(smtpImapConnector.send({ config, secrets: { smtp_password: 'secret' }, cursor: {} }, message), /not all accepted/);
});

test('JMAP snapshots before initial query, consumes incremental changes and submits with the authorized identity', async t => {
  const MAIL = 'urn:ietf:params:jmap:mail'; const SUBMISSION = 'urn:ietf:params:jmap:submission';
  const calls = []; let submission;
  t.mock.method(network, 'mailJson', async (url, token, body) => {
    assert.equal(token, 'secret');
    if (!body) return { apiUrl: 'https://mail.example.com/api', primaryAccounts: { [MAIL]: 'a1' }, accounts: { a1: { accountCapabilities: { [MAIL]: {}, [SUBMISSION]: {} } } } };
    const [method, args] = body.methodCalls[0]; calls.push(method); let result;
    if (method === 'Mailbox/get') result = { list: [{ id: 'in', role: 'inbox' }, { id: 'draft', role: 'drafts' }, { id: 'sent', role: 'sent' }] };
    else if (method === 'Email/get') result = { state: 'state1', list: !args.ids.length ? [] : [{ id: 'e1', messageId: ['m@example.com'], mailboxIds: { in: true }, from: [{ email: 'vendor@example.com' }], to: [{ email: 'ops@example.com' }], subject: 'Report', receivedAt: '2026-01-01T00:00:00Z', textBody: [{ partId: 'text' }], bodyValues: { text: { value: 'Report body' } }, attachments: [] }] };
    else if (method === 'Email/query') result = { ids: ['e1'] };
    else if (method === 'Email/changes') result = { newState: 'state2', created: ['e1'], hasMoreChanges: true };
    else if (method === 'Identity/get') result = { list: [{ id: 'identity1', email: 'ops@example.com' }] };
    else if (method === 'Email/set') result = { created: { message: { id: 'out1' } } };
    else if (method === 'EmailSubmission/set') { submission = args; result = { created: { send: { id: 'submission1' } } }; }
    else assert.fail(method);
    return { methodResponses: [[method, { accountId: 'a1', ...result }, 'm']] };
  });
  const context = { config: { addresses: ['ops@example.com'], jmap_url: 'https://mail.example.com/.well-known/jmap' }, cursor: {}, secrets: { jmap_token: 'secret' } };
  const initial = await jmapConnector.sync(context); assert.equal(initial.messages[0].text, 'Report body');
  assert.ok(calls.indexOf('Email/get') < calls.indexOf('Email/query')); assert.equal(initial.cursor.state, 'state1');
  const next = await jmapConnector.sync({ ...context, cursor: initial.cursor }); assert.equal(next.has_more, true); assert.equal(next.cursor.state, 'state2');
  await jmapConnector.send(context, { from: 'ops@example.com', to: ['vendor@example.com'], subject: 'Reply', text: 'Recorded', message_id: '<out@example.com>' });
  assert.equal(submission.create.send.identityId, 'identity1'); assert.equal(submission.create.send.emailId, 'out1');
});
