// Marketing 메일 — docs/marketing.md "메일" (정보통신망법 §50 · CAN-SPAM).
//
// 고정하는 것:
//   1. 순수 규칙: 야간(현지 21–08시) 판정과 다음 발송 시각, 동의 2 년, 한국/국가 미상은 언제나 "(광고)", 꼬리말 · 헤더.
//   2. 연락처는 사람이 동의 증거와 함께 넣는다(방법 · 출처 · 시각 필수). 수신거부 · 삭제된 주소는 다시 가져와도 억제된다.
//   3. 메일 승인: AWB_PUBLIC_URL 이 없으면 승인되지 않고 글은 draft 로 남는다. 승인하면 목록의 발송 대상(동의 유효)만 큐에 든다.
//   4. 발송: 야간 동의 없는 수신자는 아침까지 deferred, 보내기 직전 수신거부했으면 suppressed, 4xx → failed, 5xx → 다시 시도.
//      제목 앞 광고 표기 · 발신자 정보 · 수신거부 링크 · List-Unsubscribe(One-Click)가 강제된다. 큐가 끝나면 글은 published.
//   5. 공개 수신거부: GET 은 확인 화면(아무것도 바꾸지 않음), POST(버튼 · One-Click)가 처리 — 토큰과 무관하게 같은 응답,
//      처리 안내 메일. 에이전트는 연락처를 못 보고 목록 인원만 안다.
//
// 실행: node --test --test-force-exit test/marketing-email.test.mjs (dist 필요)

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAccount, createAgent, createApiKey, createUser } from './helpers/fixtures.mjs';
import { McpClient } from './helpers/mcp-client.mjs';
import { encrypt } from '../dist/services/encryption.service.js';
import { MarketingEmailService } from '../dist/modules/marketing/marketing-email.service.js';
import { sendEmail } from '../dist/modules/marketing/marketing-email-providers.js';
import {
  isNightFor, nextSendableAt, consentFresh, adLabelFor, composeMarketingEmail, localHour,
} from '../dist/common/marketing/email.js';

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

/** now 이후 처음으로 그 시간대의 시가 hour 인 시각(정각). */
function nextLocalHour(now, tz, hour) {
  let t = new Date(Math.ceil(now.getTime() / 3_600_000) * 3_600_000);
  for (let i = 0; i < 48 && localHour(t, tz) !== hour; i++) t = new Date(t.getTime() + 3_600_000);
  return t;
}

test('email rules: night hours, consent age, ad label, footer and headers', () => {
  const seoulNight = new Date('2026-10-22T14:30:00Z'); // 23:30 KST
  assert.equal(isNightFor(seoulNight, 'Asia/Seoul'), true);
  assert.equal(isNightFor(new Date('2026-10-22T03:00:00Z'), 'Asia/Seoul'), false); // 12:00 KST
  assert.equal(nextSendableAt(seoulNight, 'Asia/Seoul').toISOString(), '2026-10-22T23:00:00.000Z', '08:00 KST');
  assert.equal(nextSendableAt(new Date('2026-10-22T03:00:00Z'), 'Asia/Seoul').toISOString(), '2026-10-22T03:00:00.000Z');
  const now = new Date('2026-10-22T00:00:00Z');
  assert.equal(consentFresh(new Date('2025-01-01T00:00:00Z'), now), true);
  assert.equal(consentFresh(new Date('2024-01-01T00:00:00Z'), now), false);
  assert.equal(adLabelFor('[Ad]', 'KR'), '(광고)');
  assert.equal(adLabelFor('[Ad]', ''), '(광고)', 'unknown country gets the strictest rule');
  assert.equal(adLabelFor('[Ad]', 'US'), '[Ad]');
  const mail = composeMarketingEmail({
    sender: { from_name: 'AWB', from_address: 'hi@awb.example.com', reply_to: '', postal_address: '1 Main St, Seoul', contact_email: 'help@awb.example.com', ad_label: '(광고)' },
    title: 'AWB 1.0 출시', body: '본문', unsubscribeUrl: 'https://awb.example.com/api/m/u/tok', contact: { country: 'KR', consent_at: new Date('2026-01-02T00:00:00Z') },
  });
  assert.equal(mail.subject, '(광고) AWB 1.0 출시');
  assert.match(mail.text, /AWB · 1 Main St, Seoul · help@awb\.example\.com/);
  assert.match(mail.text, /무료로 수신거부.*https:\/\/awb\.example\.com\/api\/m\/u\/tok/);
  assert.match(mail.text, /수신 동의일 \/ Consent date: 2026-01-02/);
  assert.equal(mail.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.match(mail.headers['List-Unsubscribe'], /^<https:\/\/awb\.example\.com\/api\/m\/u\/tok>, <mailto:help@awb\.example\.com\?subject=unsubscribe>$/);
});

test('email providers: retry only when a resend cannot duplicate the message', async () => {
  const sender = { from_name: 'AWB', from_address: 'hi@awb.example.com', reply_to: '', postal_address: 'Seoul', contact_email: 'hi@awb.example.com', ad_label: '(광고)' };
  const base = { apiKey: 'k', sender, to: { email: 'a@example.com', name: '' }, message: { subject: 's', text: 't', headers: {} }, idempotencyKey: 'send-1' };
  const timeout = async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
  const status = (code) => async () => new Response('{}', { status: code });
  let seenHeaders = null;
  const ok = async (url, init) => { seenHeaders = init.headers; return new Response('{"id":"re_1"}', { status: 200 }); };
  assert.equal((await sendEmail({ ...base, provider: 'resend', fetchImpl: ok })).outcome, 'sent');
  assert.equal(seenHeaders['idempotency-key'], 'send-1', 'Resend gets a stable idempotency key');
  assert.equal((await sendEmail({ ...base, provider: 'resend', fetchImpl: timeout })).outcome, 'retry', 'idempotent → safe to retry');
  assert.equal((await sendEmail({ ...base, provider: 'resend', fetchImpl: status(503) })).outcome, 'retry');
  const sgTimeout = await sendEmail({ ...base, provider: 'sendgrid', fetchImpl: timeout });
  assert.equal(sgTimeout.outcome, 'failed', 'SendGrid has no idempotency key — a timeout may already be delivered');
  assert.match(sgTimeout.error, /may have been delivered/);
  assert.equal((await sendEmail({ ...base, provider: 'sendgrid', fetchImpl: status(503) })).outcome, 'failed');
  assert.equal((await sendEmail({ ...base, provider: 'sendgrid', fetchImpl: status(429) })).outcome, 'retry', '429 means not accepted');
  assert.equal((await sendEmail({ ...base, provider: 'resend', fetchImpl: status(422) })).outcome, 'failed');
});

test('marketing email: consented contacts, queue, night deferral, compliance footer, unsubscribe', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(async () => { await closeTestApp(app); delete process.env.AWB_PUBLIC_URL; });
  const { getDataSourceToken, AuthService } = modules;
  const ds = app.get(getDataSourceToken());
  const base = `http://127.0.0.1:${port}`;
  process.env.AWB_PUBLIC_URL = base;
  const emailService = app.get(MarketingEmailService);
  const sent = [];
  const replies = [];
  emailService.fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ url, body, auth: init.headers.authorization, idem: init.headers['idempotency-key'] });
    const reply = replies.shift() || { status: 200, body: { id: `re_${sent.length}` } };
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  };

  const account = await createAccount(app, getDataSourceToken, 'mkt-mail');
  const admin = await createUser(app, getDataSourceToken, { name: 'mkt-mail-admin', role: 'admin' });
  const H = { Authorization: `Bearer ${app.get(AuthService).createSession(admin.id)}`, 'X-Account-Id': account.id, 'Content-Type': 'application/json' };
  const api = (path, init = {}) => call(`${base}/api/marketing${path}`, { headers: H, ...init });
  const post = (path, body = {}) => api(path, { method: 'POST', body: JSON.stringify(body) });

  const brand = (await post('/brands', { name: 'AWB Team' })).body;
  const agent = await createAgent(app, getDataSourceToken, account.id, { name: 'mkt-mail-agent', type: 'claude', runtime: true });
  const campaign = (await post('/campaigns', { name: 'Mail', agent_runtime: agent.runtime_spec, capabilities: ['email'] })).body;
  await post(`/campaigns/${campaign.id}/status`, { status: 'active' });
  const cred = await ds.getRepository('Credential').save(ds.getRepository('Credential').create({
    account_id: account.id, name: 'resend', description: '', provider: 'custom', encrypted_data: encrypt(JSON.stringify({ provider: 'resend', api_key: 're_secret_key' })),
  }));
  const channel = (await post(`/campaigns/${campaign.id}/channels`, { platform: 'email', target: 'early access' })).body;
  const approvedChannel = await post(`/channels/${channel.id}/approve`, { mode: 'email', email: { brand_id: brand.id,
    credential_id: cred.id, from_name: 'AWB Team', from_address: 'hello@awb.example.com', reply_to: 'help@awb.example.com',
    postal_address: '1 Main St, Seoul', list_name: 'early access', ad_label: '[Ad]',
  } });
  assert.equal(approvedChannel.body.status, 'active', approvedChannel.text);

  // 2. 연락처
  const day = 24 * 60 * 60_000;
  const consent = (overrides = {}) => ({ consent_method: 'signup_form', consent_source: 'https://awb.example.com/signup', consent_at: new Date(Date.now() - 30 * day).toISOString(), consent_text_version: 'v1', ...overrides });
  const imported = await post('/contacts/import', { brand_id: brand.id, lists: ['Early Access'], contacts: [
    { email: 'Kim@Example.com', name: 'Kim', country: 'KR', timezone: 'Asia/Seoul', ...consent() },
    { email: 'bob@example.com', name: 'Bob', country: 'US', timezone: 'America/New_York', night_consent: true, ...consent() },
    { email: 'old@example.com', name: 'Old', country: 'KR', ...consent({ consent_at: new Date(Date.now() - 800 * day).toISOString() }) },
    { email: 'gone@example.com', name: 'Gone', ...consent() },
    { email: 'noevidence@example.com' },
    { email: 'not-an-email', ...consent() },
    { email: 'future@example.com', ...consent({ consent_at: new Date(Date.now() + 10 * day).toISOString() }) },
  ] });
  assert.equal(imported.status, 200, imported.text);
  assert.equal(imported.body.created, 4);
  assert.equal(imported.body.invalid.length, 3);
  const contactRepo = ds.getRepository('MarketingContact');
  const kim = await contactRepo.findOneBy({ email: 'kim@example.com' });
  const bob = await contactRepo.findOneBy({ email: 'bob@example.com' });
  const gone = await contactRepo.findOneBy({ email: 'gone@example.com' });
  const old = await contactRepo.findOneBy({ email: 'old@example.com' });
  const bobConsent = await ds.getRepository('MarketingContactConsent').findOneBy({ contact_id: bob.id, brand_id: brand.id });
  assert.deepEqual(kim.lists, ['early access']);
  const listed = await api('/contacts?list=early%20access');
  assert.equal(listed.body.total, 4);
  assert.ok(!JSON.stringify(listed.body).includes(kim.unsubscribe_token), 'unsubscribe tokens never leave the server');
  assert.equal((await post(`/contacts/${gone.id}/unsubscribe`, { note: 'asked by phone' })).body.status, 'unsubscribed');
  assert.equal((await post('/contacts/import', { brand_id: brand.id, lists: ['early access'], contacts: [{ email: 'gone@example.com', ...consent() }] })).body.suppressed, 1,
    'an unsubscribed address is not resubscribed by import');
  const erased = await post(`/contacts/${old.id}/erase`);
  assert.equal(erased.body.email, null);
  assert.equal(erased.body.status, 'erased');
  assert.equal((await post('/contacts/import', { brand_id: brand.id, lists: ['early access'], contacts: [{ email: 'OLD@example.com', ...consent() }] })).body.suppressed, 1,
    'an erased address stays suppressed by its hash');

  // 에이전트는 연락처를 못 보고 인원만 안다.
  const key = await createApiKey(app, getDataSourceToken, agent.id, { accountId: account.id, label: 'mkt-mail' });
  const mcp = new McpClient({ baseUrl: base, apiKey: key.raw_key });
  t.after(() => mcp.close().catch(() => {}));
  const overview = await mcp.callTool('get_marketing_campaign', { campaign_id: campaign.id });
  assert.equal(overview.channels.find((c) => c.id === channel.id).audience_count, 2);
  assert.ok(!JSON.stringify(overview).includes('kim@example.com'));

  // 3. 승인 전제
  const drafted = await mcp.callTool('draft_marketing_post', { campaign_id: campaign.id, channel_id: channel.id, title: 'AWB 1.0 is here', body: 'Hello! AWB 1.0 ships today.', rationale: 'launch' });
  assert.equal(drafted.post.kind, 'email', JSON.stringify(drafted));
  delete process.env.AWB_PUBLIC_URL;
  const noUrl = await post(`/posts/${drafted.post.id}/approve`, {});
  assert.equal(noUrl.status, 409);
  assert.match(noUrl.body.error, /unsubscribe link/);
  assert.equal((await api(`/posts/${drafted.post.id}`)).body.status, 'draft', 'a refused approval leaves the draft untouched');
  process.env.AWB_PUBLIC_URL = base;
  const queued = await post(`/posts/${drafted.post.id}/approve`, {});
  assert.equal(queued.body.status, 'sending', queued.text);
  let sends = (await api(`/posts/${drafted.post.id}/sends`)).body;
  assert.deepEqual(sends.counts, { queued: 2 }, 'only subscribed contacts with fresh consent are queued');

  // 4. 발송 — 서울 23시: kim 은 아침까지 보류, bob 은 야간 동의가 있어 발송
  const seoulNight = nextLocalHour(new Date(), 'Asia/Seoul', 23);
  const first = await emailService.processQueue(seoulNight);
  assert.deepEqual(first, { sent: 1, deferred: 1, failed: 0, suppressed: 0 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://api.resend.com/emails');
  assert.equal(sent[0].auth, 'Bearer re_secret_key');
  assert.deepEqual(sent[0].body.to, ['bob@example.com']);
  assert.equal(sent[0].body.subject, '[Ad] AWB 1.0 is here', 'non-KR recipients get the channel label');
  assert.equal(sent[0].body.from, '"AWB Team" <hello@awb.example.com>');
  assert.equal(sent[0].body.reply_to, 'help@awb.example.com');
  assert.match(sent[0].body.text, new RegExp(`${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/api/m/u/${bobConsent.unsubscribe_token}`));
  assert.match(sent[0].body.text, /AWB Team · 1 Main St, Seoul · help@awb\.example\.com/);
  assert.equal(sent[0].body.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  const bobSend = await ds.getRepository('MarketingEmailSend').findOneBy({ post_id: drafted.post.id, contact_id: bob.id });
  assert.equal(sent[0].idem, bobSend.id, 'the send row id is the idempotency key');
  const kimSend = await ds.getRepository('MarketingEmailSend').findOneBy({ post_id: drafted.post.id, contact_id: kim.id });
  assert.equal(kimSend.status, 'deferred');
  assert.equal(localHour(kimSend.next_attempt_at, 'Asia/Seoul'), 8);
  assert.equal((await api(`/posts/${drafted.post.id}`)).body.status, 'sending', 'not done while someone is deferred');
  const morning = new Date(kimSend.next_attempt_at.getTime() + 60_000);
  // 캠페인을 멈추면 큐도 멈춘다(버리지 않고 보류) — 재개하면 이어서 보낸다.
  await post(`/campaigns/${campaign.id}/status`, { status: 'paused' });
  assert.deepEqual(await emailService.processQueue(morning), { sent: 0, deferred: 1, failed: 0, suppressed: 0 });
  const pausedRow = await ds.getRepository('MarketingEmailSend').findOneBy({ id: kimSend.id });
  assert.match(pausedRow.error, /campaign is paused/);
  await post(`/campaigns/${campaign.id}/status`, { status: 'active' });
  const resumedAt = new Date(pausedRow.next_attempt_at.getTime() + 60_000);
  assert.deepEqual(await emailService.processQueue(resumedAt), { sent: 1, deferred: 0, failed: 0, suppressed: 0 });
  assert.equal(sent[1].body.subject, '(광고) AWB 1.0 is here', 'KR recipients always get (광고)');
  const done = (await api(`/posts/${drafted.post.id}`)).body;
  assert.equal(done.status, 'published');
  sends = (await api(`/posts/${drafted.post.id}/sends`)).body;
  assert.deepEqual(sends.counts, { sent: 2 });

  // 보내기 직전 재확인 · 4xx · 5xx
  const second = await mcp.callTool('draft_marketing_post', { campaign_id: campaign.id, channel_id: channel.id, title: 'Week 2', body: 'Tips.', rationale: 'follow-up' });
  await post(`/posts/${second.post.id}/approve`, {});
  await contactRepo.update({ id: kim.id }, { status: 'unsubscribed' });
  replies.push({ status: 503, body: { message: 'busy' } });
  const noon = nextLocalHour(new Date(), 'Asia/Seoul', 12);
  assert.deepEqual(await emailService.processQueue(noon), { sent: 0, deferred: 1, failed: 0, suppressed: 1 });
  await contactRepo.update({ id: kim.id }, { status: 'subscribed' });
  replies.push({ status: 422, body: { message: 'invalid recipient' } });
  const retryAt = new Date(noon.getTime() + 11 * 60_000);
  assert.deepEqual(await emailService.processQueue(retryAt), { sent: 0, deferred: 0, failed: 1, suppressed: 0 });
  const secondDone = (await api(`/posts/${second.post.id}`)).body;
  assert.equal(secondDone.status, 'published');
  assert.match(secondDone.error, /1 message\(s\) failed/);

  // Deterministically interleave two workers after the slower worker's SELECT.
  // Real SQL claims/writes and provider responses; no parallel-transaction claim for sql.js.
  for (const providerStatus of [429, 503]) {
    for (const retryDue of [false, true]) {
      await t.test(`two workers: ${providerStatus}, retry ${retryDue ? 'due' : 'still deferred'}`, async () => {
        await contactRepo.update({ id: kim.id }, { status: 'unsubscribed' });
        const draft = await mcp.callTool('draft_marketing_post', {
          campaign_id: campaign.id, channel_id: channel.id,
          title: 'Concurrent retry', body: 'Tips.', rationale: 'follow-up',
        });
        await post(`/posts/${draft.post.id}/approve`, {});
        await contactRepo.update({ id: kim.id }, { status: 'subscribed' });
        const sendRepo = ds.getRepository('MarketingEmailSend');
        const candidate = await sendRepo.findOneBy({ post_id: draft.post.id, contact_id: bob.id });
        const callsBefore = sent.length;
        let deferred;
        let selections = 0;
        // Separate running flag and repository wrapper, with the same real dependencies.
        const slowerWorker = Object.assign(Object.create(MarketingEmailService.prototype), emailService, {
          running: false,
          sendRepo: new Proxy(sendRepo, {
            get(target, key) {
              if (key === 'find') return async (options) => {
                const stale = await target.find(options);
                if (options.where.status === 'sending') return stale;
                selections++;
                assert.deepEqual(stale.map((row) => row.id), [candidate.id]);
                assert.equal(stale[0].attempts, 0);
                replies.push({ status: providerStatus, body: { message: 'busy' } });
                assert.deepEqual(await emailService.processQueue(noon), { sent: 0, deferred: 1, failed: 0, suppressed: 0 });
                deferred = await target.findOneBy({ id: candidate.id });
                if (retryDue) replies.push({ status: providerStatus, body: { message: 'busy again' } });
                return stale;
              };
              const value = Reflect.get(target, key);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          }),
        });
        const slowNow = new Date(noon.getTime() + (retryDue ? 10 * 60_000 : 0));
        assert.deepEqual(await slowerWorker.processQueue(slowNow), {
          sent: 0, deferred: retryDue ? 1 : 0, failed: 0, suppressed: 0,
        });
        assert.equal(selections, 1);
        assert.equal(sent.length - callsBefore, retryDue ? 2 : 1);
        const latest = await sendRepo.findOneBy({ id: candidate.id });
        assert.equal(latest.status, 'deferred');
        assert.equal(latest.attempts, retryDue ? 2 : 1, 'use the claimed row, not the stale candidate');
        assert.equal(latest.next_attempt_at.getTime(), retryDue
          ? slowNow.getTime() + 20 * 60_000 : deferred.next_attempt_at.getTime());
        if (!retryDue) assert.deepEqual(latest, deferred, 'losing worker must leave the deferred row untouched');
        // Finish this queue before the next interleaving.
        assert.equal((await emailService.processQueue(latest.next_attempt_at)).sent, 1);
      });
    }
  }

  // Two brands share identities/lists, but queue selection and withdrawal remain independent.
  const brandB = (await post('/brands', { name: 'Second Brand' })).body;
  await post('/contacts/import', { brand_id: brandB.id, lists: ['early access'], contacts: [
    { email: 'kim@example.com', ...consent(), night_consent: true },
    { email: 'bob@example.com', ...consent(), night_consent: true },
  ] });
  const channelB = (await post(`/campaigns/${campaign.id}/channels`, { platform: 'email', target: 'brand-b' })).body;
  assert.equal((await post(`/channels/${channelB.id}/approve`, { mode: 'email', email: {
    brand_id: brandB.id, credential_id: cred.id, from_name: 'Untrusted display name', from_address: 'hello@awb.example.com',
    postal_address: 'Seoul', list_name: 'early access',
  } })).status, 200);
  const brandDraft = await mcp.callTool('draft_marketing_post', { campaign_id: campaign.id, channel_id: channelB.id, title: 'Brand B', body: 'Hello', rationale: 'test' });
  await post(`/posts/${brandDraft.post.id}/approve`, {});
  assert.equal((await api(`/posts/${brandDraft.post.id}/sends`)).body.counts.queued, 2);
  const kimB = await ds.getRepository('MarketingContactConsent').findOneBy({ contact_id: kim.id, brand_id: brandB.id });
  await fetch(`${base}/api/m/u/${kimB.unsubscribe_token}`, { method: 'POST' });
  assert.equal((await contactRepo.findOneBy({ id: kim.id })).status, 'subscribed');
  assert.deepEqual(await emailService.processQueue(noon), { sent: 1, deferred: 0, failed: 0, suppressed: 1 });
  const brandMessage = sent.find(m => m.body.subject.includes('Brand B'));
  assert.match(brandMessage.body.from, /Second Brand/);
  assert.ok(!brandMessage.body.from.includes('Untrusted display name'));
  assert.equal((await mcp.callTool('get_marketing_campaign', { campaign_id: campaign.id })).channels.find(c => c.id === channel.id).audience_count, 2);
  const changedDraft = await mcp.callTool('draft_marketing_post', { campaign_id: campaign.id, channel_id: channelB.id, title: 'Pinned brand', body: 'Hello', rationale: 'test' });
  await post(`/posts/${changedDraft.post.id}/approve`, {});
  const channelRepo = ds.getRepository('MarketingChannel');
  const changedChannel = await channelRepo.findOneBy({ id: channelB.id });
  await channelRepo.update({ id: channelB.id }, { config: { ...changedChannel.config, brand_id: brand.id } });
  assert.deepEqual(await emailService.processQueue(noon), { sent: 0, deferred: 0, failed: 0, suppressed: 1 }, 'queued brand cannot silently change');

  // 5. 공개 수신거부
  const confirm = await fetch(`${base}/api/m/u/${kim.unsubscribe_token}`);
  const confirmHtml = await confirm.text();
  assert.equal(confirm.status, 200);
  assert.match(confirmHtml, /<form method="post">/);
  assert.ok(!confirmHtml.includes('kim@example.com'), 'the page does not reveal whose address it is');
  assert.equal((await contactRepo.findOneBy({ id: kim.id })).status, 'subscribed', 'GET changes nothing (mail scanners open links)');
  const bogus = await (await fetch(`${base}/api/m/u/${'x'.repeat(43)}`, { method: 'POST' })).text();
  const real = await (await fetch(`${base}/api/m/u/${kim.unsubscribe_token}`, { method: 'POST' })).text();
  assert.equal(bogus, real, 'valid and invalid tokens get the same answer');
  const kimAfter = await contactRepo.findOneBy({ id: kim.id });
  assert.equal(kimAfter.status, 'unsubscribed');
  assert.equal(kimAfter.unsubscribe_source, 'link');
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(sent.some((m) => m.body.to[0] === 'kim@example.com' && /수신거부 처리 안내/.test(m.body.subject)), 'the recipient is told the result');
  const oneClick = await fetch(`${base}/api/m/u/${bob.unsubscribe_token}`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click',
  });
  assert.equal(oneClick.status, 200);
  assert.equal((await contactRepo.findOneBy({ id: bob.id })).unsubscribe_source, 'one_click');
  const overviewAfter = await mcp.callTool('get_marketing_campaign', { campaign_id: campaign.id });
  assert.equal(overviewAfter.channels.find((c) => c.id === channel.id).audience_count, 0);

  const actions = new Set((await api(`/campaigns/${campaign.id}/audit?limit=500`)).body.map((e) => e.action));
  for (const a of ['email.queued', 'email.completed', 'post.sent']) assert.ok(actions.has(a), `audit has ${a}`);
});
