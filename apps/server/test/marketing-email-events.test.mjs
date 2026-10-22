// Marketing 메일 공급자 webhook — docs/marketing.md "공급자 이벤트", "답장", "목록 발송 중지".
//
// 고정하는 것:
//   1. 서명이 곧 인증이다: 서명이 없거나 틀리거나, 주소의 credential 에 서명 키가 없거나, 없는 credential 이면 같은 401 이고
//      아무것도 바뀌지 않는다. 한 credential 의 이벤트는 다른 credential 로 보낸 발송 행에 닿지 않는다.
//   2. 보낼 때 발송 행 id 를 공급자에 싣고(Resend tags · SendGrid custom_args) 발송 행에 credential_id 를 남긴다.
//   3. Resend: 하드 바운스 → bounced, 소프트 바운스 → 발송 행에만, 스팸 신고 → complained(태그 없이 email_id 로도). 같은 이벤트를
//      다시 받아도 결과가 같다. SendGrid: bounce · spamreport · dropped(예전 신고의 반복은 새 신고로 세지 않음) · unsubscribe,
//      Event Webhook 과 Inbound Parse 의 키는 따로다.
//   4. 목록 발송 중지: 신고 2건 이상 · 닿은 메일의 0.3% 이상 → 그 목록의 큐는 보류(버리지 않음), 새 메일 승인 · 에이전트 초안 거부,
//      개요에 표시. 사람이 사유를 적어 해제하면 보류된 메일이 바로 나가고, 해제 전에 보낸 메일의 신고는 다시 세지 않는다.
//   5. 답장: Resend email.received(받은 메일 API) · SendGrid Inbound Parse → MarketingFeedback(other, 시스템 기록). 인용 원문 ·
//      주소 · 수신거부 링크를 지운 본문만. 모르는 사람의 메일과 자동 응답은 기록하지 않고 본문도 읽지 않는다. 제목 unsubscribe 는
//      수신거부(+ 안내 메일). 에이전트(MCP)에는 연락처가 보이지 않고, 사람용 REST 에는 답장한 연락처가 실린다.
//
// 실행: node --test --test-force-exit test/marketing-email-events.test.mjs (dist 필요)

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAccount, createAgent, createApiKey, createUser } from './helpers/fixtures.mjs';
import { McpClient } from './helpers/mcp-client.mjs';
import { encrypt } from '../dist/services/encryption.service.js';
import { MarketingListHoldService } from '../dist/modules/marketing/marketing-list-hold.service.js';
import { MarketingEmailService } from '../dist/modules/marketing/marketing-email.service.js';
import { MarketingEmailEventsService } from '../dist/modules/marketing/marketing-email-events.service.js';

process.env.PORT = process.env.TEST_SERVER_PORT || '0';
process.env.AGENT_DEV_MODE = 'false';
process.env.MARKETING_SCHEDULER_ENABLED = 'false';
process.env.OUTREACH_SCHEDULER_ENABLED = 'false';

async function call(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: res.status, body, text };
}

const der = (key) => key.export({ format: 'der', type: 'spki' }).toString('base64');

test('marketing email webhooks: signatures, bounces, complaints, list hold, replies', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(async () => { await closeTestApp(app); delete process.env.AWB_PUBLIC_URL; });
  const { getDataSourceToken, AuthService } = modules;
  const ds = app.get(getDataSourceToken());
  const base = `http://127.0.0.1:${port}`;
  process.env.AWB_PUBLIC_URL = base;

  // 공급자 호출 — 발송(Resend · SendGrid)과 Resend 받은 메일 API.
  const emailService = app.get(MarketingEmailService);
  const eventsService = app.get(MarketingEmailEventsService);
  const sent = [];
  emailService.fetchImpl = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    if (url.includes('sendgrid')) return new Response('', { status: 202, headers: { 'x-message-id': `sg${sent.length}` } });
    return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 });
  };
  const inbox = new Map();
  const inboxCalls = [];
  eventsService.fetchImpl = async (url, init) => {
    inboxCalls.push({ url, auth: init.headers.authorization });
    const id = decodeURIComponent(url.split('/').pop());
    const r = inbox.get(id) || { status: 404, body: { message: 'not found' } };
    return new Response(JSON.stringify(r.body || {}), { status: r.status });
  };

  const account = await createAccount(app, getDataSourceToken, 'mkt-hooks');
  const admin = await createUser(app, getDataSourceToken, { name: 'mkt-hooks-admin', role: 'admin' });
  const H = { Authorization: `Bearer ${app.get(AuthService).createSession(admin.id)}`, 'X-Account-Id': account.id, 'Content-Type': 'application/json' };
  const api = (path, init = {}) => call(`${base}/api/marketing${path}`, { headers: H, ...init });
  const post = (path, body = {}) => api(path, { method: 'POST', body: JSON.stringify(body) });

  const agent = await createAgent(app, getDataSourceToken, account.id, { name: 'mkt-hooks-agent', type: 'claude', runtime: true });
  const campaign = (await post('/campaigns', { name: 'Hooks', agent_runtime: agent.runtime_spec, capabilities: ['email', 'feedback_collect'] })).body;
  await post(`/campaigns/${campaign.id}/status`, { status: 'active' });

  // credential — Resend(Svix 비밀), SendGrid(Event · Inbound 키 따로), 서명 키 없는 Resend.
  const credRepo = ds.getRepository('Credential');
  const saveCred = (name, data) => credRepo.save(credRepo.create({ account_id: account.id, name, description: '', provider: 'custom', encrypted_data: encrypt(JSON.stringify(data)) }));
  const whsec = `whsec_${randomBytes(24).toString('base64')}`;
  const sgEvents = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const sgInbound = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const resendCred = await saveCred('resend', { provider: 'resend', api_key: 're_key', webhook_secret: whsec });
  const sgCred = await saveCred('sendgrid', { provider: 'sendgrid', api_key: 'SG.key', webhook_public_key: der(sgEvents.publicKey), inbound_public_key: der(sgInbound.publicKey) });
  const bareCred = await saveCred('resend-bare', { provider: 'resend', api_key: 're_bare' });

  const emailChannel = async (platform, target, credential, list, replyTo) => {
    const ch = (await post(`/campaigns/${campaign.id}/channels`, { platform, target })).body;
    const approved = await post(`/channels/${ch.id}/approve`, { mode: 'email', email: {
      credential_id: credential.id, from_name: 'AWB Team', from_address: 'hello@awb.example.com', reply_to: replyTo,
      postal_address: '1 Main St, Seoul', list_name: list,
    } });
    assert.equal(approved.body.status, 'active', approved.text);
    return approved.body;
  };
  const chNews = await emailChannel('email', 'news', resendCred, 'news', 'help@awb.example.com');
  const chWeekly = await emailChannel('newsletter', 'weekly', sgCred, 'weekly', 'reply@awb.example.com');

  const consent = { consent_method: 'signup_form', consent_source: 'https://awb.example.com/signup', consent_at: new Date(Date.now() - 30 * 86_400_000).toISOString(), night_consent: true };
  const people = (prefix, n) => Array.from({ length: n }, (_, i) => ({ email: `${prefix}${i + 1}@example.com`, name: `${prefix}${i + 1}`, country: 'US', timezone: 'UTC', ...consent }));
  assert.equal((await post('/contacts/import', { lists: ['news'], contacts: people('n', 6) })).body.created, 6);
  assert.equal((await post('/contacts/import', { lists: ['weekly'], contacts: people('w', 5) })).body.created, 5);
  const contactRepo = ds.getRepository('MarketingContact');
  const sendRepo = ds.getRepository('MarketingEmailSend');
  const contact = async (email) => contactRepo.findOneBy({ email });

  const key = await createApiKey(app, getDataSourceToken, agent.id, { accountId: account.id, label: 'mkt-hooks' });
  const mcp = new McpClient({ baseUrl: base, apiKey: key.raw_key });
  t.after(() => mcp.close().catch(() => {}));
  const draft = async (channel, title) => {
    const r = await mcp.callTool('draft_marketing_post', { campaign_id: campaign.id, channel_id: channel.id, title, body: `${title} — details inside.`, rationale: 'test' });
    assert.ok(r?.post?.id, JSON.stringify(r));
    return r.post;
  };

  // ── 2. 보낼 때 실는 것 ────────────────────────────────────────────────────
  const p1 = await draft(chNews, 'AWB news');
  assert.equal((await post(`/posts/${p1.id}/approve`, {})).body.status, 'sending');
  const p2 = await draft(chWeekly, 'AWB weekly');
  assert.equal((await post(`/posts/${p2.id}/approve`, {})).body.status, 'sending');
  assert.deepEqual(await emailService.processQueue(new Date()), { sent: 11, deferred: 0, failed: 0, suppressed: 0 });
  const sendOf = async (postId, email) => sendRepo.findOneBy({ post_id: postId, contact_id: (await contact(email)).id });
  const n1Send = await sendOf(p1.id, 'n1@example.com');
  const w1Send = await sendOf(p2.id, 'w1@example.com');
  const resendMail = sent.find((m) => m.url.includes('resend') && m.body.to[0] === 'n1@example.com');
  assert.deepEqual(resendMail.body.tags, [{ name: 'awb_send_id', value: n1Send.id }], 'Resend carries the send row id as a tag');
  const sgMail = sent.find((m) => m.url.includes('sendgrid') && m.body.personalizations[0].to[0].email === 'w1@example.com');
  assert.deepEqual(sgMail.body.personalizations[0].custom_args, { awb_send_id: w1Send.id }, 'SendGrid carries it as a custom arg');
  assert.equal(n1Send.credential_id, resendCred.id);
  assert.equal(w1Send.credential_id, sgCred.id);
  assert.match(w1Send.provider_message_id, /^sg\d+$/);

  // ── 1. 서명 ────────────────────────────────────────────────────────────────
  const svix = (secret, payload, { id = `msg_${randomUUID()}`, ts = Math.floor(Date.now() / 1000) } = {}) => {
    const raw = Buffer.from(JSON.stringify(payload));
    const sig = createHmac('sha256', Buffer.from(secret.replace(/^whsec_/, ''), 'base64')).update(`${id}.${ts}.`).update(raw).digest('base64');
    return { raw, headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${sig}` } };
  };
  const resendHook = (payload, { cred = resendCred, secret = whsec, path = 'events' } = {}) => {
    const { raw, headers } = svix(secret, payload);
    return call(`${base}/api/m/email/${cred.id}/${path}`, { method: 'POST', headers, body: raw });
  };
  const at = () => new Date().toISOString();
  const bounce = (send, email, type = 'Permanent', tags = { awb_send_id: send.id }) => ({
    type: 'email.bounced', created_at: at(),
    data: { email_id: send.provider_message_id, to: [email], tags, bounce: { type, subType: 'General', message: 'mailbox unavailable' } },
  });

  const unsigned = await call(`${base}/api/m/email/${resendCred.id}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bounce(n1Send, 'n1@example.com')) });
  assert.equal(unsigned.status, 401);
  const wrongSecret = await resendHook(bounce(n1Send, 'n1@example.com'), { secret: `whsec_${randomBytes(24).toString('base64')}` });
  const noKey = await resendHook(bounce(n1Send, 'n1@example.com'), { cred: bareCred });
  const unknownCred = await resendHook(bounce(n1Send, 'n1@example.com'), { cred: { id: randomUUID() } });
  const notUuid = await resendHook(bounce(n1Send, 'n1@example.com'), { cred: { id: 'abc' } });
  for (const r of [wrongSecret, noKey, unknownCred, notUuid]) {
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, unsigned.body, 'every refusal looks the same');
  }
  assert.equal((await contact('n1@example.com')).status, 'subscribed', 'nothing changed by refused calls');

  // ── 3. Resend 이벤트 ───────────────────────────────────────────────────────
  const hard = await resendHook(bounce(n1Send, 'n1@example.com'));
  assert.equal(hard.status, 200, hard.text);
  assert.equal(hard.body.applied, 1);
  const n1 = await contact('n1@example.com');
  assert.equal(n1.status, 'bounced');
  assert.equal(n1.unsubscribe_source, 'bounce');
  const n1Row = await sendRepo.findOneBy({ id: n1Send.id });
  assert.equal(n1Row.bounce_type, 'hard');
  assert.ok(n1Row.bounced_at);
  assert.match(n1Row.event_note, /Permanent\/General — mailbox unavailable/);
  const again = await resendHook(bounce(n1Send, 'n1@example.com'));
  assert.deepEqual([again.body.applied, again.body.unchanged], [0, 1], 'a redelivered event changes nothing');

  const n2Send = await sendOf(p1.id, 'n2@example.com');
  assert.equal((await resendHook(bounce(n2Send, 'n2@example.com', 'Transient'))).body.applied, 1);
  assert.equal((await contact('n2@example.com')).status, 'subscribed', 'a soft bounce does not suppress the contact');
  assert.equal((await sendRepo.findOneBy({ id: n2Send.id })).bounce_type, 'soft');

  const n3Send = await sendOf(p1.id, 'n3@example.com');
  const complaint = (send, email, tags = {}) => ({ type: 'email.complained', created_at: at(), data: { email_id: send.provider_message_id, to: [email], tags } });
  assert.equal((await resendHook(complaint(n3Send, 'n3@example.com'))).body.applied, 1, 'matched by email_id without tags');
  assert.equal((await contact('n3@example.com')).status, 'complained');
  assert.ok((await sendRepo.findOneBy({ id: n3Send.id })).complained_at);
  assert.equal((await api('/list-holds')).body.length, 0, 'one complaint alone never stops a list');

  // 이 Resend credential 로 보내지 않은 메일(SendGrid 채널)에는 닿지 않는다 — 행 id 를 알아도.
  const foreign = await resendHook(bounce(w1Send, 'w1@example.com'));
  assert.deepEqual([foreign.body.applied, foreign.body.unmatched], [0, 1]);
  assert.equal((await contact('w1@example.com')).status, 'subscribed');
  assert.equal((await sendRepo.findOneBy({ id: w1Send.id })).bounce_type, '');
  const delivered = await resendHook({ type: 'email.delivered', created_at: at(), data: { email_id: n1Send.provider_message_id, to: ['n1@example.com'] } });
  assert.deepEqual([delivered.status, delivered.body.received], [200, 0], 'other events are acknowledged and ignored');

  // ── 4. 목록 발송 중지 ──────────────────────────────────────────────────────
  const p3 = await draft(chNews, 'AWB news 2');
  assert.equal((await post(`/posts/${p3.id}/approve`, {})).body.status, 'sending');
  assert.deepEqual((await api(`/posts/${p3.id}/sends`)).body.counts, { queued: 4 }, 'bounced and complained contacts are not queued');
  const p4 = await draft(chNews, 'AWB news 3');
  const n4Send = await sendOf(p1.id, 'n4@example.com');
  assert.equal((await resendHook(complaint(n4Send, 'n4@example.com', { awb_send_id: n4Send.id }))).body.applied, 1);
  const holds = (await api('/list-holds')).body;
  assert.equal(holds.length, 1, 'two complaints over four delivered mails stop the list');
  assert.equal(holds[0].list_name, 'news');
  assert.equal(holds[0].status, 'held');
  assert.equal(holds[0].stats.complained, 2);
  const channels = (await api(`/campaigns/${campaign.id}/channels`)).body;
  const newsView = channels.find((c) => c.id === chNews.id);
  assert.equal(newsView.email_hold.id, holds[0].id);
  assert.equal(newsView.email_webhooks.events_url, `${base}/api/m/email/${resendCred.id}/events`);
  assert.equal(newsView.email_webhooks.inbound_url, null, 'Resend sends received mail on the same webhook');
  assert.equal(newsView.email_webhooks.events_signing, true);
  const weeklyView = channels.find((c) => c.id === chWeekly.id);
  assert.equal(weeklyView.email_hold, null);
  assert.equal(weeklyView.email_webhooks.inbound_url, `${base}/api/m/email/${sgCred.id}/inbound`);
  assert.ok(!JSON.stringify(channels).includes(whsec) && !JSON.stringify(channels).includes('SG.key'), 'secrets never leave the server');

  assert.deepEqual(await emailService.processQueue(new Date()), { sent: 0, deferred: 3, failed: 0, suppressed: 1 },
    'the queue is held, not dropped (n4 complained meanwhile and is suppressed)');
  const heldRow = await sendOf(p3.id, 'n5@example.com');
  assert.equal(heldRow.status, 'deferred');
  assert.match(heldRow.error, /^deferred: the list is on hold/);
  const refused = await post(`/posts/${p4.id}/approve`, {});
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /on hold/);
  assert.equal((await api(`/posts/${p4.id}`)).body.status, 'draft');
  const agentDraft = await mcp.callTool('draft_marketing_post', { campaign_id: campaign.id, channel_id: chNews.id, title: 'more', body: 'more', rationale: 'x' });
  assert.equal(agentDraft.isError, true, 'the agent cannot draft for a held list');
  const overview = await mcp.callTool('get_marketing_campaign', { campaign_id: campaign.id });
  assert.equal(overview.channels.find((c) => c.id === chNews.id).list_on_hold, true);
  assert.equal(overview.channels.find((c) => c.id === chWeekly.id).list_on_hold, false);
  assert.ok(!('email_webhooks' in overview.channels.find((c) => c.id === chNews.id)), 'webhook settings are for people only');

  assert.equal((await post(`/list-holds/${holds[0].id}/release`, {})).status, 400, 'a release needs a reason');
  const released = await post(`/list-holds/${holds[0].id}/release`, { note: 'checked the signup source; removed a scraped batch' });
  assert.equal(released.status, 200, released.text);
  assert.equal(released.body.status, 'released');
  assert.equal((await post(`/list-holds/${holds[0].id}/release`, { note: 'again' })).status, 409);
  assert.deepEqual(await emailService.processQueue(new Date()), { sent: 3, deferred: 0, failed: 0, suppressed: 0 }, 'held mail goes out right after the release');
  // 해제 전에 보낸 메일의 신고는 해제 이후 수치에 들지 않는다.
  const n5OldSend = await sendOf(p1.id, 'n5@example.com');
  assert.equal((await resendHook(complaint(n5OldSend, 'n5@example.com'))).body.applied, 1);
  assert.equal((await contact('n5@example.com')).status, 'complained');
  assert.deepEqual((await api('/list-holds?status=held')).body, []);

  // ── 3'. SendGrid 이벤트 ────────────────────────────────────────────────────
  const sgHook = (events, privateKey = sgEvents.privateKey, path = 'events') => {
    const raw = Buffer.from(`${JSON.stringify(events)}\r\n`);
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = sign('sha256', Buffer.concat([Buffer.from(ts), raw]), privateKey).toString('base64');
    return call(`${base}/api/m/email/${sgCred.id}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-twilio-email-event-webhook-timestamp': ts, 'x-twilio-email-event-webhook-signature': signature },
      body: raw,
    });
  };
  const w2Send = await sendOf(p2.id, 'w2@example.com');
  const now = Math.floor(Date.now() / 1000);
  const sgEventsBatch = [
    { email: 'w1@example.com', event: 'processed', timestamp: now },
    { email: 'w1@example.com', event: 'bounce', type: 'bounce', status: '5.1.1', reason: 'user unknown', awb_send_id: w1Send.id, timestamp: now },
    { email: 'w2@example.com', event: 'spamreport', sg_message_id: `${w2Send.provider_message_id}.filterdrecv-1`, timestamp: now },
    { email: 'w3@example.com', event: 'dropped', reason: 'Spam Reporting Address', timestamp: now },
    { email: 'w4@example.com', event: 'unsubscribe', timestamp: now },
    { email: 'w5@example.com', event: 'delivered', timestamp: now },
  ];
  assert.equal((await sgHook(sgEventsBatch, sgInbound.privateKey)).status, 401, 'the Inbound Parse key does not sign events');
  const sgOk = await sgHook(sgEventsBatch);
  assert.equal(sgOk.status, 200, sgOk.text);
  assert.deepEqual([sgOk.body.received, sgOk.body.applied], [4, 4]);
  assert.equal((await contact('w1@example.com')).status, 'bounced');
  assert.equal((await sendRepo.findOneBy({ id: w1Send.id })).bounce_type, 'hard');
  assert.equal((await contact('w2@example.com')).status, 'complained');
  assert.ok((await sendRepo.findOneBy({ id: w2Send.id })).complained_at);
  const w3 = await contact('w3@example.com');
  assert.equal(w3.status, 'complained', 'SendGrid dropped it because of an earlier complaint');
  const w3Row = await sendOf(p2.id, 'w3@example.com');
  assert.deepEqual([w3Row.bounce_type, w3Row.complained_at], ['suppressed', null], 'a repeat is not counted as a new complaint');
  const w4 = await contact('w4@example.com');
  assert.deepEqual([w4.status, w4.unsubscribe_source], ['unsubscribed', 'provider']);
  assert.equal((await contact('w5@example.com')).status, 'subscribed');
  assert.deepEqual((await api('/list-holds?status=held')).body, [], 'one new complaint on weekly is not enough');

  // ── 5. 답장 ────────────────────────────────────────────────────────────────
  const n6 = await contact('n6@example.com');
  const received = (id, from, subject = 'Re: (광고) AWB news') => ({
    type: 'email.received', created_at: at(),
    data: { email_id: id, from, to: ['help@awb.example.com'], subject, message_id: `<${id}@mail.example.com>` },
  });
  inbox.set('in_1', { status: 200, body: {
    from: 'N6 <n6@example.com>', to: ['help@awb.example.com'], subject: 'Re: (광고) AWB news', headers: { 'message-id': '<in_1@mail.example.com>' },
    text: `I love the new release! Ping me at n6.private@example.com\n\nOn Tue, Oct 21, 2026 at 10:00 AM AWB Team <hello@awb.example.com> wrote:\n> (광고) AWB news\n> ${base}/api/m/u/${n6.unsubscribe_token}`,
  } });
  const replied = await resendHook(received('in_1', 'n6@example.com'));
  assert.deepEqual([replied.status, replied.body.reply], [200, 'recorded'], replied.text);
  assert.equal(inboxCalls.at(-1).auth, 'Bearer re_key', 'the body is read with the channel credential');
  assert.match(inboxCalls.at(-1).url, /\/emails\/receiving\/in_1$/);
  const feedbackRepo = ds.getRepository('MarketingFeedback');
  const reply = await feedbackRepo.findOneBy({ campaign_id: campaign.id, contact_id: n6.id });
  assert.equal(reply.content, 'I love the new release! Ping me at [메일 주소]');
  assert.equal(reply.category, 'other');
  assert.equal(reply.recorded_by_type, 'system');
  assert.equal(reply.author, '');
  assert.equal(reply.channel_id, chNews.id);
  assert.equal(reply.post_id, p3.id, 'the reply belongs to the latest mail that person got');
  assert.equal((await resendHook(received('in_1', 'n6@example.com'))).body.reply, 'duplicate', 'redelivery records once');
  assert.equal(await feedbackRepo.countBy({ contact_id: n6.id }), 1);

  const callsBefore = inboxCalls.length;
  assert.equal((await resendHook(received('in_x', 'stranger@example.com'))).body.reply, 'ignored');
  assert.equal(inboxCalls.length, callsBefore, 'mail from someone we never mailed is not even opened');
  inbox.set('in_auto', { status: 200, body: { from: 'n2@example.com', subject: 'Automatic reply: AWB news', headers: { 'auto-submitted': 'auto-replied' }, text: 'I am away until Monday.' } });
  assert.equal((await resendHook(received('in_auto', 'n2@example.com', 'Automatic reply: AWB news'))).body.reply, 'ignored');
  inbox.set('in_spoof', { status: 200, body: { from: 'n2@example.com', subject: 'unsubscribe', text: '', authentication: { spf: 'fail', dkim: 'fail', dmarc: 'fail' } } });
  assert.equal((await resendHook(received('in_spoof', 'n2@example.com', 'unsubscribe'))).body.reply, 'ignored', 'a spoofed sender (DMARC fail) is not trusted');
  assert.equal((await contact('n2@example.com')).status, 'subscribed');
  inbox.set('in_500', { status: 500, body: {} });
  assert.equal((await resendHook(received('in_500', 'n2@example.com'))).status, 503, 'a transient read failure asks Svix to retry');
  inbox.set('in_403', { status: 403, body: { message: 'restricted key' } });
  assert.equal((await resendHook(received('in_403', 'n2@example.com'))).body.reply, 'recorded');
  assert.match((await feedbackRepo.findOneBy({ source_key: 'email-reply:resend:<in_403@mail.example.com>' })).content, /^\(본문을 읽지 못했습니다/);

  inbox.set('in_unsub', { status: 200, body: { from: 'n2@example.com', subject: 'unsubscribe', text: '' } });
  const sentBefore = sent.length;
  assert.equal((await resendHook(received('in_unsub', 'n2@example.com', 'unsubscribe'))).body.reply, 'unsubscribed');
  const n2 = await contact('n2@example.com');
  assert.deepEqual([n2.status, n2.unsubscribe_source], ['unsubscribed', 'mailto'], 'the List-Unsubscribe mailto works');
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(sent.slice(sentBefore).some((m) => m.body.to?.[0] === 'n2@example.com' && /수신거부 처리 안내/.test(m.body.subject)), 'the recipient is told');

  // SendGrid Inbound Parse(multipart, 서명 키는 Inbound 것).
  const boundary = `----awb${randomBytes(6).toString('hex')}`;
  const field = (name, value) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const multipart = Buffer.from([
    field('headers', 'Message-ID: <sg-in-1@example.com>\nSubject: Re: AWB weekly\n'),
    field('from', 'W5 <w5@example.com>'),
    field('to', 'reply@awb.example.com'),
    field('subject', 'Re: AWB weekly'),
    field('text', 'Please add CSV export.\n\n-- \nW5\n010-0000-0000'),
    field('charsets', '{"from":"UTF-8","to":"UTF-8","subject":"UTF-8","text":"UTF-8","headers":"UTF-8"}'),
    `--${boundary}--\r\n`,
  ].join(''));
  const inbound = (privateKey) => {
    const ts = String(Math.floor(Date.now() / 1000));
    return call(`${base}/api/m/email/${sgCred.id}/inbound`, {
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'x-twilio-email-event-webhook-timestamp': ts,
        'x-twilio-email-event-webhook-signature': sign('sha256', Buffer.concat([Buffer.from(ts), multipart]), privateKey).toString('base64'),
      },
      body: multipart,
    });
  };
  assert.equal((await inbound(sgEvents.privateKey)).status, 401, 'the Event Webhook key does not sign Inbound Parse');
  const sgReply = await inbound(sgInbound.privateKey);
  assert.deepEqual([sgReply.status, sgReply.body.reply], [200, 'recorded'], sgReply.text);
  const w5 = await contact('w5@example.com');
  const w5Reply = await feedbackRepo.findOneBy({ contact_id: w5.id });
  assert.equal(w5Reply.content, 'Please add CSV export.', 'the signature (with a phone number) is cut');
  assert.equal(w5Reply.channel_id, chWeekly.id);

  // 에이전트는 연락처를 못 본다 — 사람용 화면만 답장한 사람을 안다.
  const agentView = await mcp.callTool('list_marketing_feedback', { campaign_id: campaign.id });
  const agentText = JSON.stringify(agentView);
  assert.ok(agentView.recorded.some((f) => f.content_untrusted === 'I love the new release! Ping me at [메일 주소]'), agentText.slice(0, 500));
  for (const leak of ['n6@example.com', 'w5@example.com', 'n6.private', n6.unsubscribe_token, n6.id]) {
    assert.ok(!agentText.includes(leak), `agents never see ${leak}`);
  }
  const humanView = (await api(`/campaigns/${campaign.id}/feedback`)).body;
  assert.equal(humanView.recorded.find((f) => f.id === reply.id).contact.email, 'n6@example.com');

  const p1Sends = (await api(`/posts/${p1.id}/sends`)).body.sends;
  assert.equal(p1Sends.find((s) => s.id === n1Send.id).bounce_type, 'hard', 'send history shows provider outcomes');
  const actions = new Set((await api(`/campaigns/${campaign.id}/audit?limit=500`)).body.map((e) => e.action));
  for (const a of ['contact.bounced', 'contact.complained', 'contact.unsubscribed', 'list.held', 'list.released', 'feedback.recorded']) {
    assert.ok(actions.has(a), `audit has ${a}`);
  }

  // Dedicated list: soft -> hard upgrade, duplicate delivery, hold, release and recount.
  const bounceChannel = await emailChannel('email', 'old-list', resendCred, 'old-list', 'help@awb.example.com');
  await post('/contacts/import', { lists: ['old-list'], contacts: people('b', 5) });
  const bp = await draft(bounceChannel, 'Bounce test');
  await post(`/posts/${bp.id}/approve`, {});
  await emailService.processQueue(new Date());
  const b1 = await sendOf(bp.id, 'b1@example.com');
  const b2 = await sendOf(bp.id, 'b2@example.com');
  const b3 = await sendOf(bp.id, 'b3@example.com');
  const b4 = await sendOf(bp.id, 'b4@example.com');
  const holdService = app.get(MarketingListHoldService);
  await resendHook(bounce(b1, 'b1@example.com'));
  await resendHook(bounce(b1, 'b1@example.com'));
  await resendHook(bounce(b2, 'b2@example.com', 'Transient'));
  assert.equal(await holdService.active(account.id, 'old-list'), null);
  const queued = await draft(bounceChannel, 'Queued');
  await post(`/posts/${queued.id}/approve`, {});
  const unapproved = await draft(bounceChannel, 'Unapproved');
  await resendHook(bounce(b2, 'b2@example.com'));
  const bh = await holdService.active(account.id, 'old-list');
  assert.equal(bh.reason, 'hard_bounce_rate');
  assert.equal(bh.stats.hard_bounced, 2);
  assert.equal(bh.stats.sent, 5);
  assert.equal(bh.stats.rate, 0.4);
  assert.equal(bh.stats.threshold, 0.05);
  assert.equal(bh.stats.min_hard_bounces, 2);
  assert.equal((await post(`/posts/${unapproved.id}/approve`, {})).status, 409);
  await emailService.processQueue(new Date());
  assert.equal((await sendOf(queued.id, 'b3@example.com')).status, 'deferred');
  await resendHook(bounce(b2, 'b2@example.com'));
  assert.equal((await api('/list-holds?list=old-list')).body.length, 1);
  assert.equal((await post(`/list-holds/${bh.id}/release`, { note: 'Removed stale addresses' })).status, 200);
  // Ensure the old cohort is strictly before the release even on coarse clocks.
  await sendRepo.update({ post_id: bp.id }, { sent_at: new Date(Date.now() - 60_000) });
  await resendHook(bounce(b3, 'b3@example.com'));
  await resendHook(bounce(b4, 'b4@example.com'));
  assert.equal(await holdService.active(account.id, 'old-list'), null, 'late old bounces cannot rehold');
  await emailService.processQueue(new Date());
  assert.equal((await sendOf(queued.id, 'b5@example.com')).status, 'sent');
  // Old events outside the rolling window are excluded regardless of reason.
  const future = new Date(Date.now() + 31 * 86_400_000);
  assert.equal((await holdService.stats(account.id, 'old-list', future)).stats.hard_bounced, 0);
  // Fresh sends after release can trigger a new hold, with history retained.
  await post('/contacts/import', { lists: ['old-list'], contacts: people('fresh', 2) });
  const freshPost = await draft(bounceChannel, 'Fresh cohort');
  await post(`/posts/${freshPost.id}/approve`, {});
  await emailService.processQueue(new Date());
  for (const email of ['fresh1@example.com', 'fresh2@example.com']) {
    await resendHook(bounce(await sendOf(freshPost.id, email), email));
  }
  const newHold = await holdService.active(account.id, 'old-list');
  assert.equal(newHold.reason, 'hard_bounce_rate');
  assert.notEqual(newHold.id, bh.id);
  assert.equal(newHold.stats.hard_bounced, 2);

});
