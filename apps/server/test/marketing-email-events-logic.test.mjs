// Marketing 메일 공급자 이벤트 · 답장 — 순수 규칙(docs/marketing.md "공급자 이벤트", "답장", "목록 발송 중지").
//
// 고정하는 것:
//   1. 서명: Resend(Svix HMAC) · SendGrid(ECDSA P-256)를 공급자가 공개한 테스트 벡터로 검증한다. 받은 바이트가 하나라도
//      바뀌거나, 키가 다르거나, 시각이 허용 밖이면 거부.
//   2. 이벤트 정규화: 하드/소프트 바운스 · 공급자 억제(repeat) · 스팸 신고 · 공급자 수신거부 · 받은 메일. 나머지는 버린다.
//      보낼 때 실은 발송 행 id(tag · custom_args)와 공급자 message id 를 꺼낸다.
//   3. Inbound Parse: multipart 칸(첨부는 건너뜀) · 칸별 문자 집합 · 원문 헤더.
//   4. 답장 정리: 인용 원문 · 서명 · 메일 주소 · 수신거부 링크를 지운다. 자동 응답 · mailto 수신거부 판정.
//   5. 신고율: 신고 2건 이상이고 닿은 메일의 0.3% 이상이면 멈춘다.
//
// 실행: node --test --test-force-exit test/marketing-email-events-logic.test.mjs (dist 필요)

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import {
  parseAddress, parseMultipartFields, parseRawHeaders, parseResendEvent, parseSendGridEvents, resendInboundEmail,
  sendGridInboundEmail, verifySendGridSignature, verifySvixSignature,
} from '../dist/common/marketing/email-events.js';
import { cleanReplyText, htmlToText, isAutoReply, isUnsubscribeRequest, stripSubjectPrefixes } from '../dist/common/marketing/email-reply.js';
import { complaintRate, shouldHoldList } from '../dist/common/marketing/email.js';
import { buildCyclePrompt } from '../dist/common/marketing/cycle-prompt.js';

test('Svix (Resend) signatures: the published vector verifies, anything changed does not', () => {
  // 공개 테스트 벡터: https://docs.svix.com/receiving/verifying-payloads/how
  // 운영 키가 아니다. 접두사는 실행 시 붙여 Stripe secret scanning 오탐을 피한다.
  const testSecret = (key) => `whsec_${key.toString('base64')}`;
  const vector = {
    secret: testSecret(Buffer.from('MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', 'base64')),
    id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
    timestamp: '1614265330',
    signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
    body: Buffer.from('{"test": 2432232314}'),
    now: new Date(1614265330 * 1000),
  };
  assert.equal(verifySvixSignature(vector), true);
  assert.equal(verifySvixSignature({ ...vector, body: Buffer.from('{"test": 2432232315}') }), false, 'body changed');
  assert.equal(verifySvixSignature({ ...vector, id: 'msg_other' }), false, 'id is signed');
  assert.equal(verifySvixSignature({ ...vector, secret: testSecret(Buffer.alloc(24)) }), false, 'other secret');
  assert.equal(verifySvixSignature({ ...vector, now: new Date((1614265330 + 301) * 1000) }), false, 'older than 5 minutes');
  assert.equal(verifySvixSignature({ ...vector, signature: `v1,bm90IGl0 ${vector.signature}` }), true, 'any listed signature may match');
  assert.equal(verifySvixSignature({ ...vector, signature: vector.signature.replace('v1,', 'v2,') }), false, 'only v1 is HMAC');
  assert.equal(verifySvixSignature({ ...vector, secret: '' }), false, 'no secret configured → reject');
  assert.equal(verifySvixSignature({ ...vector, signature: '' }), false);
});

test('SendGrid signatures: the published vectors verify (ECDSA P-256 over timestamp + raw body)', () => {
  // sendgrid-nodejs packages/eventwebhook 의 테스트 벡터.
  const PUBLIC_KEY = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE83T4O/n84iotIvIW4mdBgQ/7dAfSmpqIM8kF9mN1flpVKS3GRqe62gw+2fNNRaINXvVpiglSI8eNEc6wEA3F+g==';
  const SIGNATURE = 'MEUCIGHQVtGj+Y3LkG9fLcxf3qfI10QysgDWmMOVmxG0u6ZUAiEAyBiXDWzM+uOe5W0JuG+luQAbPIqHh89M15TluLtEZtM=';
  const TIMESTAMP = '1600112502';
  const PAYLOAD = `${JSON.stringify([{
    email: 'hello@world.com', event: 'dropped', reason: 'Bounced Address', sg_event_id: 'ZHJvcC0xMDk5NDkxOS1MUnpYbF9OSFN0T0doUTRrb2ZTbV9BLTA',
    sg_message_id: 'LRzXl_NHStOGhQ4kofSm_A.filterdrecv-p3mdw1-756b745b58-kmzbl-18-5F5FC76C-9.0', 'smtp-id': '<LRzXl_NHStOGhQ4kofSm_A@ismtpd0039p1iad1.sendgrid.net>', timestamp: 1600112492,
  }])}\r\n`;
  const now = new Date(1600112502 * 1000);
  const base = { publicKey: PUBLIC_KEY, signature: SIGNATURE, timestamp: TIMESTAMP, body: Buffer.from(PAYLOAD), now };
  assert.equal(verifySendGridSignature(base), true);
  assert.equal(verifySendGridSignature({ ...base, publicKey: `-----BEGIN PUBLIC KEY-----\n${PUBLIC_KEY}\n-----END PUBLIC KEY-----` }), true, 'PEM is accepted too');
  assert.equal(verifySendGridSignature({ ...base, publicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEqTxd43gyp8IOEto2LdIfjRQrIbsd4SXZkLW6jDutdhXSJCWHw8REntlo7aNDthvj+y7GjUuFDb/R1NGe1OPzpA==' }), false, 'other key');
  assert.equal(verifySendGridSignature({ ...base, body: Buffer.from('payload') }), false, 'other payload');
  assert.equal(verifySendGridSignature({ ...base, signature: 'MEUCIQCtIHJeH93Y+qpYeWrySphQgpNGNr/U+UyUlBkU6n7RAwIgJTz2C+8a8xonZGi6BpSzoQsbVRamr2nlxFDWYNH3j/0=' }), false, 'other signature');
  assert.equal(verifySendGridSignature({ ...base, timestamp: 'timestamp' }), false, 'bad timestamp');
  assert.equal(verifySendGridSignature({ ...base, now: new Date((1600112502 + 4 * 24 * 3600) * 1000) }), false, 'older than 3 days');
  assert.equal(verifySendGridSignature({ ...base, publicKey: 'not a key' }), false);

  const events = [
    { email: 'invalid@gmail.com', event: 'processed', send_at: 0, sg_event_id: 'cHJvY2Vzc2VkLTE5OTQyMTEyLXFOd0JMZ1BRUWpXNkRKdktRd1NBYnctMA', sg_message_id: 'qNwBLgPQQjW6DJvKQwSAbw.filterdrecv-canary-547b64655b-cw6zx-1-6089EA4A-56.0', 'smtp-id': '<qNwBLgPQQjW6DJvKQwSAbw@ismtpd0178p1mdw1.sendgrid.net>', timestamp: 1619651146 },
    { email: 'invalid@gmail.com', event: 'bounce', ip: '167.89.101.76', reason: '552 5.2.2 The email account that you tried to reach is over quota and inactive. Please direct the recipient to https://support.google.com/mail/?p=OverQuotaPerm c17si1130468pgv.34 - gsmtp', sg_event_id: 'Ym91bmNlLTAtMTk5NDIxMTItcU53QkxnUFFRalc2REp2S1F3U0Fidy0w', sg_message_id: 'qNwBLgPQQjW6DJvKQwSAbw.filterdrecv-canary-547b64655b-cw6zx-1-6089EA4A-56.0', 'smtp-id': '<qNwBLgPQQjW6DJvKQwSAbw@ismtpd0178p1mdw1.sendgrid.net>', status: '5.2.2', timestamp: 1619651147, tls: 1, type: 'blocked' },
  ];
  const multi = `${JSON.stringify(events).split('},{').join('},\r\n{')}\r\n`;
  assert.equal(verifySendGridSignature({
    publicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEQ4LIFtWztlsF7skFqOncjD1lun4H5w8XOhyOArHW9RcIx/FfEzx6cikC/yPfUvwaX/JScE7Fc9CJD2afQ9Ok3Q==',
    signature: 'MEYCIQC/I4o6vCgqRYrTljjoVWB/GRWNtxeePlLMHr3x9ETeRQIhAIpV+03nREPTTHWSW0wIOA0EoMPdcNgXa70yCaqDJlu5',
    timestamp: '1619651159',
    body: Buffer.from(multi),
    now: new Date(1619651159 * 1000),
  }), true, 'multi-event vector');

  // 그 묶음의 정규화 — processed 는 버리고, type blocked 인 bounce 는 소프트.
  const parsed = parseSendGridEvents(JSON.parse(multi));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].kind, 'soft_bounce');
  assert.equal(parsed[0].recipient, 'invalid@gmail.com');
  assert.equal(parsed[0].provider_message_id, 'qNwBLgPQQjW6DJvKQwSAbw', 'sg_message_id up to the first "." is the X-Message-Id of the send');
  assert.equal(parsed[0].occurred_at.toISOString(), new Date(1619651147 * 1000).toISOString());
  assert.match(parsed[0].detail, /5\.2\.2/);
});

test('SendGrid events: hard bounce, drops from earlier suppression, complaints, unsubscribes, custom args', () => {
  const sendId = '8d8e0c4a-6a0b-4d55-9b7e-2f1c1d1e1f10';
  const events = parseSendGridEvents([
    { email: 'A@Example.com', event: 'bounce', type: 'bounce', status: '5.1.1', reason: 'user unknown', awb_send_id: sendId, timestamp: 1700000000 },
    { email: 'b@example.com', event: 'dropped', reason: 'Bounced Address', timestamp: 1700000001 },
    { email: 'c@example.com', event: 'dropped', reason: 'Spam Reporting Address', timestamp: 1700000002 },
    { email: 'd@example.com', event: 'dropped', reason: 'Unsubscribed Address', timestamp: 1700000003 },
    { email: 'e@example.com', event: 'dropped', reason: 'Invalid SMTPAPI header', timestamp: 1700000004 },
    { email: 'f@example.com', event: 'spamreport', sg_message_id: 'abc.filter', timestamp: 1700000005 },
    { email: 'g@example.com', event: 'group_unsubscribe', asm_group_id: 1, timestamp: 1700000006 },
    { email: 'h@example.com', event: 'delivered', timestamp: 1700000007 },
    { email: 'i@example.com', event: 'open', timestamp: 1700000008 },
    { email: 'j@example.com', event: 'bounce', type: 'bounce', awb_send_id: 'not-a-uuid', timestamp: 1700000009 },
    'garbage',
  ]);
  assert.deepEqual(events.map((e) => [e.recipient, e.kind, e.repeat]), [
    ['a@example.com', 'bounce', false],
    ['b@example.com', 'bounce', true],
    ['c@example.com', 'complaint', true],
    ['d@example.com', 'unsubscribe', true],
    ['f@example.com', 'complaint', false],
    ['g@example.com', 'unsubscribe', false],
    ['j@example.com', 'bounce', false],
  ]);
  assert.equal(events[0].send_id, sendId);
  assert.equal(events[4].provider_message_id, 'abc');
  assert.equal(events[6].send_id, '', 'only uuids are taken as send ids');
  assert.deepEqual(parseSendGridEvents({ not: 'an array' }), []);
});

test('Resend events: bounce types, complaint, suppression, received email, tags', () => {
  const sendId = '3b0b8c5e-2c2f-4f4e-8a8a-0f0e0d0c0b0a';
  const at = '2026-10-22T01:00:00.000Z';
  const event = (type, data) => parseResendEvent({ type, created_at: at, data: { email_id: 're_1', to: ['Kim <kim@example.com>'], tags: { awb_send_id: sendId }, ...data } });
  const hard = event('email.bounced', { bounce: { type: 'Permanent', subType: 'General', message: 'mailbox does not exist', diagnosticCode: ['smtp; 550 5.1.1 user unknown'] } });
  assert.equal(hard.events.length, 1);
  assert.deepEqual({ kind: hard.events[0].kind, repeat: hard.events[0].repeat, recipient: hard.events[0].recipient, send_id: hard.events[0].send_id, id: hard.events[0].provider_message_id },
    { kind: 'bounce', repeat: false, recipient: 'kim@example.com', send_id: sendId, id: 're_1' });
  assert.equal(hard.events[0].occurred_at.toISOString(), at);
  assert.match(hard.events[0].detail, /Permanent\/General — mailbox does not exist — smtp; 550 5\.1\.1/);
  assert.equal(event('email.bounced', { bounce: { type: 'Transient', subType: 'MailboxFull' } }).events[0].kind, 'soft_bounce');
  const suppressedBounce = event('email.bounced', { bounce: { type: 'Permanent', subType: 'Suppressed' } }).events[0];
  assert.deepEqual([suppressedBounce.kind, suppressedBounce.repeat], ['bounce', true], 'blocked by the suppression list = an earlier bounce repeating');
  assert.equal(event('email.complained', {}).events[0].kind, 'complaint');
  const suppressed = event('email.suppressed', { suppressed: { type: 'OnAccountSuppressionList', message: 'on the list' } }).events[0];
  assert.deepEqual([suppressed.kind, suppressed.repeat], ['bounce', true]);
  assert.equal(event('email.delivered', {}).events.length, 0, 'other events are ignored');
  assert.equal(event('email.bounced', { tags: [{ name: 'awb_send_id', value: sendId }], bounce: { type: 'Permanent' } }).events[0].send_id, sendId, 'array tags (older shape)');
  assert.equal(event('email.bounced', { tags: {}, bounce: { type: 'Permanent' } }).events[0].send_id, '');

  const received = parseResendEvent({ type: 'email.received', created_at: at, data: { email_id: 'in_1', from: 'Kim@Example.com', to: ['help@awb.example.com'], subject: 'Re: hello', message_id: '<abc@mail>' } });
  assert.deepEqual(received.received, { email_id: 'in_1', from: 'kim@example.com', to: ['help@awb.example.com'], subject: 'Re: hello', message_id: '<abc@mail>' });
  assert.equal(received.events.length, 0);
  const mail = resendInboundEmail(received.received, {
    from: 'Kim <kim@example.com>', to: ['help@awb.example.com'], subject: 'Re: hello', text: 'thanks!', html: '<p>thanks!</p>',
    headers: { 'Auto-Submitted': 'no', 'Message-ID': '<abc@mail>' }, message_id: '<abc@mail>',
  });
  assert.equal(mail.from, 'kim@example.com');
  assert.equal(mail.text, 'thanks!');
  assert.equal(mail.headers['auto-submitted'], 'no', 'header names are lowercased');
  assert.equal(mail.auth_failed, false, 'no authentication result is not a failure');
  assert.equal(resendInboundEmail(received.received, { from: 'kim@example.com', authentication: { spf: 'pass', dkim: 'pass', dmarc: 'fail' } }).auth_failed, true, 'DMARC fail = spoofed sender');
  assert.equal(resendInboundEmail(received.received, { from: 'kim@example.com', authentication: { spf: 'fail', dkim: 'pass', dmarc: 'pass' } }).auth_failed, false);
  assert.equal(parseAddress('"Kim, Min" <Kim@Example.com>'), 'kim@example.com');
  assert.equal(parseAddress('not an address'), '');
});

test('Inbound Parse multipart: fields by charset, attachments skipped, raw headers parsed', () => {
  const boundary = 'xYzZY';
  const euckr = Buffer.from([0xbe, 0xc8, 0xb3, 0xe7]); // "안녕" in EUC-KR
  const part = (name, value, extra = '') => Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"${extra}\r\n\r\n`),
    Buffer.isBuffer(value) ? value : Buffer.from(value),
    Buffer.from('\r\n'),
  ]);
  const body = Buffer.concat([
    part('headers', 'Message-ID: <reply-1@example.com>\nSubject: Re: hi\nX-Long: one\n two\nAuto-Submitted: no\n'),
    part('from', 'Kim <Kim@Example.com>'),
    part('to', 'help@awb.example.com, other@awb.example.com'),
    part('subject', euckr),
    part('text', 'Great product!\n\nOn Mon, Oct 20, 2026 at 9:00 AM AWB <hello@awb.example.com> wrote:\n> old'),
    part('attachment1', Buffer.from([0, 1, 2, 3]), '; filename="a.bin"\r\nContent-Type: application/octet-stream'),
    part('charsets', '{"to":"UTF-8","subject":"euc-kr","from":"UTF-8","text":"UTF-8","headers":"UTF-8"}'),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
  const fields = parseMultipartFields(body, `multipart/form-data; boundary="${boundary}"`);
  assert.deepEqual(Object.keys(fields).sort(), ['charsets', 'from', 'headers', 'subject', 'text', 'to']);
  const mail = sendGridInboundEmail(fields);
  assert.equal(mail.from, 'kim@example.com');
  assert.deepEqual(mail.to, ['help@awb.example.com', 'other@awb.example.com']);
  assert.equal(mail.subject, '안녕', 'decoded with the field charset');
  assert.equal(mail.message_id, '<reply-1@example.com>');
  assert.equal(mail.headers['x-long'], 'one two', 'folded header lines are unfolded');
  assert.equal(cleanReplyText({ text: mail.text }), 'Great product!');
  assert.equal(mail.auth_failed, false);
  const spoofed = sendGridInboundEmail({ ...fields, SPF: Buffer.from('fail'), dkim: Buffer.from('{@example.com : fail}') });
  assert.equal(spoofed.auth_failed, true, 'SPF and DKIM both failed');
  assert.equal(sendGridInboundEmail({ ...fields, SPF: Buffer.from('fail'), dkim: Buffer.from('{@example.com : pass}') }).auth_failed, false, 'DKIM passed');
  assert.equal(sendGridInboundEmail({ ...fields, SPF: Buffer.from('softfail') }).auth_failed, false);
  assert.deepEqual(parseMultipartFields(body, 'multipart/form-data'), {}, 'no boundary → nothing');
  assert.deepEqual(parseRawHeaders('A: 1\r\nB: 2\r\nA: 3'), { a: '1', b: '2' }, 'first value wins');
});

test('reply cleaning: only what the person wrote — no quoted mail, signatures, addresses or unsubscribe links', () => {
  const footer = '--\nAWB Team · 1 Main St · help@awb.example.com\n수신을 원하지 않으시면 무료로 수신거부할 수 있습니다: https://awb.example.com/api/m/u/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg';
  const gmail = `The import button is broken on Safari.\nCan you fix it? Mail me at kim.minji@example.co.kr\n\nOn Tue, Oct 21, 2026 at 10:00 AM AWB Team <hello@awb.example.com>\nwrote:\n> (광고) AWB 1.0\n> ${footer.split('\n').join('\n> ')}`;
  assert.equal(cleanReplyText({ text: gmail }), 'The import button is broken on Safari.\nCan you fix it? Mail me at [메일 주소]');
  const korean = '좋아요! 다음 버전도 기대합니다.\n\n2026년 10월 21일 (화) 오전 10:00, AWB Team <hello@awb.example.com>님이 작성:\n> 본문';
  assert.equal(cleanReplyText({ text: korean }), '좋아요! 다음 버전도 기대합니다.');
  const outlook = 'Please remove the dark mode bug.\n\nFrom: AWB Team <hello@awb.example.com>\nSent: Tuesday, October 21, 2026 10:00 AM\nTo: kim@example.com\nSubject: AWB 1.0';
  assert.equal(cleanReplyText({ text: outlook }), 'Please remove the dark mode bug.');
  const signed = 'Love it.\n-- \nKim Minji\n010-1234-5678';
  assert.equal(cleanReplyText({ text: signed }), 'Love it.', 'signatures carry phone numbers and addresses');
  const inlineQuote = 'My answer\n> quoted line\nmore of mine';
  assert.equal(cleanReplyText({ text: inlineQuote }), 'My answer\nmore of mine');
  const unquotedFooter = `Thanks\nhttps://awb.example.com/api/m/u/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg`;
  assert.equal(cleanReplyText({ text: unquotedFooter }), 'Thanks\n[수신거부 링크]', 'the token in the unsubscribe link never reaches the agent');
  const html = '<div dir="ltr">Works <b>great</b> &amp; fast&nbsp;&#x1F600;<br>Second line</div><div class="gmail_quote">On … wrote:<blockquote>old mail</blockquote></div>';
  assert.equal(htmlToText(html).trim(), 'Works great & fast 😀\nSecond line');
  assert.equal(cleanReplyText({ text: '', html }), 'Works great & fast 😀\nSecond line', 'html only when there is no text part');
  assert.equal(cleanReplyText({ text: '> only quoted\n> text' }), '');
  const long = cleanReplyText({ text: 'x'.repeat(9000) });
  assert.equal(long.length, 8000);
  assert.ok(long.endsWith('…'));
});

test('reply cleaning stays linear on hostile input (anyone can mail the reply address)', () => {
  const cases = {
    'long run without @': 'a'.repeat(200_000),
    'many @ without a domain': 'a@'.repeat(100_000),
    'long run of spaces': `x${' '.repeat(200_000)}y`,
    'unsubscribe path without a token end': `/api/m/u/${'A'.repeat(200_000)}`,
    'many link starts': 'http://x/api/m/u'.repeat(20_000),
    'long attribution-ish line': `On ${'x'.repeat(200_000)} wrote:`,
  };
  for (const [name, text] of Object.entries(cases)) {
    const t0 = performance.now();
    const out = cleanReplyText({ text });
    assert.ok(performance.now() - t0 < 1000, `${name} took ${Math.round(performance.now() - t0)}ms`);
    assert.ok(out.length <= 8000, name);
  }
  const htmlCases = {
    'unclosed tags': '<div'.repeat(100_000),
    'unclosed script': `<script>${'x'.repeat(200_000)}`,
    'many tags': '<b>x</b>'.repeat(50_000),
  };
  for (const [name, html] of Object.entries(htmlCases)) {
    const t0 = performance.now();
    cleanReplyText({ html });
    assert.ok(performance.now() - t0 < 1000, `${name} took ${Math.round(performance.now() - t0)}ms`);
  }
  const t0 = performance.now();
  parseAddress(`<${'a@'.repeat(50_000)}`);
  assert.ok(performance.now() - t0 < 200, 'address parsing is capped');
});

test('auto replies and mailto unsubscribes are recognised; ordinary replies are not', () => {
  assert.equal(isAutoReply({ 'auto-submitted': 'auto-replied' }, 'Re: hi'), true);
  assert.equal(isAutoReply({ 'auto-submitted': 'no' }, 'Re: hi'), false);
  assert.equal(isAutoReply({ precedence: 'bulk' }, 'Re: hi'), true);
  assert.equal(isAutoReply({ 'x-autoreply': 'yes' }, 'Re: hi'), true);
  assert.equal(isAutoReply({ 'x-auto-response-suppress': 'All' }, 'Re: hi'), false, 'a request not to auto-reply is not an auto reply');
  assert.equal(isAutoReply({}, 'Automatic reply: AWB 1.0'), true);
  assert.equal(isAutoReply({}, 'Out of Office: back Monday'), true);
  assert.equal(isAutoReply({}, '자동 회신: AWB 1.0'), true);
  assert.equal(isAutoReply({}, 'Re: AWB 1.0'), false);
  assert.equal(isUnsubscribeRequest('unsubscribe'), true);
  assert.equal(isUnsubscribeRequest('Re: Unsubscribe '), true);
  assert.equal(isUnsubscribeRequest('수신거부'), true);
  assert.equal(isUnsubscribeRequest('unsubscribe link does not work'), false, 'only the List-Unsubscribe mailto subject, not words in a question');
  assert.equal(stripSubjectPrefixes('RE: Fwd: 답장: AWB'), 'AWB');
});

test('complaint rate: hold at two or more complaints and 0.3% of delivered mail', () => {
  assert.equal(complaintRate({ sent: 1000, bounced: 0, complained: 3 }), 0.003);
  assert.equal(complaintRate({ sent: 1000, bounced: 500, complained: 3 }), 0.006, 'bounces were never delivered');
  assert.equal(shouldHoldList({ sent: 1000, bounced: 0, complained: 2 }), false, '0.2% is under the line');
  assert.equal(shouldHoldList({ sent: 1000, bounced: 0, complained: 3 }), true, '0.3% reaches it');
  assert.equal(shouldHoldList({ sent: 50, bounced: 0, complained: 1 }), false, 'one person alone never stops a list');
  assert.equal(shouldHoldList({ sent: 50, bounced: 0, complained: 2 }), true);
  assert.equal(shouldHoldList({ sent: 0, bounced: 0, complained: 0 }), false);
  assert.equal(complaintRate({ sent: 2, bounced: 2, complained: 2 }), 1);
});

test('cycle prompt: a held mailing list is marked so the agent does not draft for it', () => {
  const prompt = buildCyclePrompt({
    cycle: { id: 'c1', cycle_no: 3, trigger: 'schedule' },
    campaign: { id: 'k1', name: 'Launch', product_brief: 'b', goal: '', target_audience: '', capabilities: ['email'], currency: 'KRW', allowed_domains: [], payees: [] },
    rules: [], limits: {}, budget: [], pending: { drafts: 0, spend: 0, allocations: 0, channels: 0 }, decisions: [], report: [], previous: null,
    channels: [{ id: 'ch1', name: 'Newsletter', platform: 'email', kind: 'email', status: 'active', target: 'news', guidelines: '', rules_summary: '', audience_count: 10, on_hold: true }],
    untrusted: [{ source: 'Newsletter · 메일 답장', author: '', category: 'other', text: 'Love it [메일 주소]' }],
  });
  assert.match(prompt, /수신 대상 10명 · 발송 중지\(스팸 신고율\)/);
  assert.match(prompt, /\[other\] 익명 \(Newsletter · 메일 답장\): Love it \[메일 주소\]/);
});

test('SendGrid signatures made with a key generated here verify; the other key does not (integration helper sanity)', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const der = (k) => k.export({ format: 'der', type: 'spki' }).toString('base64');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = Buffer.from('[{"event":"spamreport"}]\r\n');
  const signature = sign('sha256', Buffer.concat([Buffer.from(timestamp), body]), privateKey).toString('base64');
  assert.equal(verifySendGridSignature({ publicKey: der(publicKey), signature, timestamp, body }), true);
  assert.equal(verifySendGridSignature({ publicKey: der(other.publicKey), signature, timestamp, body }), false);
  // Svix 도 같은 식으로 만든 서명이 맞는다.
  const secret = `whsec_${Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')}`;
  const sig = createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`msg_1.${timestamp}.`).update(body).digest('base64');
  assert.equal(verifySvixSignature({ secret, id: 'msg_1', timestamp, signature: `v1,${sig}`, body }), true);
});
