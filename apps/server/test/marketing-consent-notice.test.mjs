// Marketing 수신 동의 재확인 안내 — docs/marketing.md "동의 재확인 안내" (정보통신망법 §50⑧ · 시행령 §62의3).
//
// 고정하는 것:
//   1. 설정은 운영자가 정한다(marketing.manage, 자기 계정만): 기본은 꺼짐 · 기본 문구. 범위 밖 발송 시점 · 모르는 자리표시자는
//      400, AWB_PUBLIC_URL 없이 켜면 409. 문구 · 무응답 처리를 바꾸면 version 이 오르고 감사에 그 문구가 남는다. 미리보기는
//      실제로 나갈 모양이다.
//   2. 줄 세우기: 켠 계정의 subscribed 연락처 가운데 기한 lead_days 일 안에 든 사람만, (연락처, 기한)마다 한 번.
//      기한이 이미 지난 동의 · 수신거부한 사람에게는 보내지 않는다.
//   3. 보내기: 발신자는 그 사람의 목록을 쓰는 메일 채널(최근 받은 메일의 채널이 먼저). 채널이 없으면 미룬다. 광고 표기 없이
//      법정 항목 · 유지/철회 링크가 들어 있고, 공급자에 안내 행 id 가 멱등 키 · tag 로 간다. 수신자 현지 야간이면 아침으로
//      미룬다. 보내기 직전에 새 동의(기한이 바뀜) · 기한 지남이면 건너뛴다. 일시 오류는 3 번까지, 공급자가 거절하면 failed —
//      사람이 기한 전에 다시 보낼 수 있다. 보내던 중 끊긴 행은 failed(다시 보내지 않음).
//   4. 무응답 처리: keep 으로 나간 안내는 **기한에** 그 기한부터 동의를 잇는다(원래 기한을 넘겨도 발송 대상, 다음 주기도).
//      안내 기간 중 새 동의가 들어오면 잇지 않는다(새 동의가 다음 주기를 정한다). lapse 면 기한에 빠진다.
//   5. 유지 링크: GET 은 아무것도 바꾸지 않는다. POST 는 새 동의(동의일 = 지금, method reconfirm, 이어진 기간은 지움)이고
//      두 번 눌러도(동시에 눌러도) 한 번이다. 행이 failed 여도 받고, 기한 30 일 뒤에는 받지 않는다. 수신거부한 사람은 되살리지
//      않는다. 철회는 수신거부 링크 그대로다. 토큰은 REST 에 나가지 않는다.
//   6. 안내에 온 공급자 이벤트(신고 · 바운스)와 mailto 수신거부는 캠페인 메일을 받은 적 없는 연락처에도 닿는다. 닿지 않은
//      안내로는 동의를 잇지 않는다. 모르는 사람의 메일은 열지 않는다.
//
// 실행: node --test --test-force-exit test/marketing-consent-notice.test.mjs (dist 필요)

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAccount, createAgent, createUser } from './helpers/fixtures.mjs';
import { encrypt } from '../dist/services/encryption.service.js';
import { MarketingEmailService } from '../dist/modules/marketing/marketing-email.service.js';
import { MarketingEmailEventsService } from '../dist/modules/marketing/marketing-email-events.service.js';
import { MarketingContactService } from '../dist/modules/marketing/marketing-contact.service.js';
import { MarketingConsentNoticeService } from '../dist/modules/marketing/marketing-consent-notice.service.js';
import { CONSENT_MAX_AGE_MS, localHour } from '../dist/common/marketing/email.js';

process.env.PORT = process.env.TEST_SERVER_PORT || '0';
process.env.AGENT_DEV_MODE = 'false';
process.env.MARKETING_SCHEDULER_ENABLED = 'false';
process.env.OUTREACH_SCHEDULER_ENABLED = 'false';

const DAY = 24 * 60 * 60_000;
const MINUTE = 60_000;

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

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const evidence = { consent_method: 'signup_form', consent_source: 'https://awb.example.com/signup' };
/** 기한이 지금부터 deadlineInDays 일 뒤가 되는 동의 시각. */
const consentFor = (deadlineInDays) => new Date(Date.now() - CONSENT_MAX_AGE_MS + deadlineInDays * DAY).toISOString();

/** 앱 하나 · 계정 · 관리자 · 캠페인 · Resend credential · 공급자 호출 가로채기. */
async function setup(t, name, credentialData = {}) {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(async () => { await closeTestApp(app); delete process.env.AWB_PUBLIC_URL; });
  const { getDataSourceToken, AuthService } = modules;
  const ds = app.get(getDataSourceToken());
  const base = `http://127.0.0.1:${port}`;
  process.env.AWB_PUBLIC_URL = base;
  const notices = app.get(MarketingConsentNoticeService);
  const sent = [];
  const replies = [];
  const capture = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ url, body, idem: init.headers['idempotency-key'] });
    const reply = replies.shift() || { status: 200, body: { id: `re_${randomUUID()}` } };
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  };
  notices.fetchImpl = capture;
  app.get(MarketingEmailService).fetchImpl = capture;

  const account = await createAccount(app, getDataSourceToken, name);
  const admin = await createUser(app, getDataSourceToken, { name: `${name}-admin`, role: 'admin' });
  const session = (user) => `Bearer ${app.get(AuthService).createSession(user.id)}`;
  const H = { Authorization: session(admin), 'X-Account-Id': account.id, 'Content-Type': 'application/json' };
  const api = (path, init = {}) => call(`${base}/api/marketing${path}`, { headers: H, ...init });
  let brand;
  const post = (path, body = {}) => api(path, { method: 'POST', body: JSON.stringify(path === '/contacts/import' ? { ...body, brand_id: brand.id } : body) });
  const put = (path, body = {}) => api(path, { method: 'PUT', body: JSON.stringify(body) });

  brand = await ds.getRepository('MarketingBrand').save({ account_id: account.id, name: 'AWB Team' });
  const agent = await createAgent(app, getDataSourceToken, account.id, { name: `${name}-agent`, type: 'claude', runtime: true });
  const campaign = (await post('/campaigns', { name, agent_runtime: agent.runtime_spec, capabilities: ['email'] })).body;
  await post(`/campaigns/${campaign.id}/status`, { status: 'active' });
  const credRepo = ds.getRepository('Credential');
  const cred = await credRepo.save(credRepo.create({
    account_id: account.id, name: 'resend', description: '', provider: 'custom',
    encrypted_data: encrypt(JSON.stringify({ provider: 'resend', api_key: 're_secret_key', ...credentialData })),
  }));
  const approveEmail = async (target, fromName, from) => {
    const proposed = (await post(`/campaigns/${campaign.id}/channels`, { platform: 'email', target })).body;
    const approved = await post(`/channels/${proposed.id}/approve`, { mode: 'email', email: {
      brand_id: brand.id, credential_id: cred.id, from_name: fromName, from_address: from, reply_to: 'help@awb.example.com', postal_address: '1 Main St, Seoul',
      contact_email: 'help@awb.example.com', list_name: target,
    } });
    assert.equal(approved.body.status, 'active', approved.text);
    return approved.body;
  };
  const contactRepo = ds.getRepository('MarketingContact');
  const noticeRepo = ds.getRepository('MarketingConsentNotice');
  const consentRepo = ds.getRepository('MarketingContactConsent');
  const consentOf = (contact) => consentRepo.findOneBy({ account_id: account.id, contact_id: contact.id, brand_id: brand.id });
  const withConsent = async (contact) => {
    if (!contact) return null;
    const consent = await consentOf(contact);
    return { ...contact, ...consent, id: contact.id };
  };
  return {
    app, ds, base, notices, sent, replies, account, admin, session, H, api, post, put, cred, brand, approveEmail, contactRepo, consentRepo, consentOf, noticeRepo, modules,
    byEmail: async (email) => withConsent(await contactRepo.findOneBy({ account_id: account.id, email })),
    noticeOf: (contact) => noticeRepo.findOneBy({ contact_id: contact.id }),
  };
}

test('consent reconfirmation notices: settings, queue, keep and lapse, keep link, withdraw', async (t) => {
  const env = await setup(t, 'mkt-consent');
  const { app, ds, base, notices, sent, replies, account, session, H, api, post, put, cred, byEmail, noticeOf, contactRepo, noticeRepo } = env;
  const { getDataSourceToken } = env.modules;
  const contactsService = app.get(MarketingContactService);
  const early = await env.approveEmail('early access', 'AWB Team', 'hello@awb.example.com');
  await env.approveEmail('beta', 'Beta Team', 'beta@awb.example.com');

  // 1. 설정 — 권한 · 계정
  const plain = await createUser(app, getDataSourceToken, { name: 'mkt-consent-plain', role: 'user' });
  assert.equal((await call(`${base}/api/marketing/consent-notices/settings`, { headers: { ...H, Authorization: session(plain) } })).status, 403,
    'marketing.manage only');
  const other = await createUser(app, getDataSourceToken, { name: 'mkt-consent-other', role: 'admin' });
  await createAccount(app, getDataSourceToken, 'mkt-consent-other', { ownerUserId: other.id });
  for (const path of ['/consent-notices/settings', `/consent-notices?account_id=${account.id}`]) {
    const foreign = await call(`${base}/api/marketing${path}`, { headers: { ...H, Authorization: session(other) } });
    assert.equal(foreign.status, 403, `another account's owner cannot read ${path}: ${foreign.text}`);
  }
  const initial = await api('/consent-notices/settings');
  assert.equal(initial.status, 200, initial.text);
  assert.equal(initial.body.settings.enabled, false, 'off until the operator turns it on');
  assert.equal(initial.body.settings.version, 0);
  assert.equal(initial.body.settings.on_no_response, 'keep');
  assert.match(initial.body.settings.subject, /\{\{sender\}\}/);
  assert.equal((await put('/consent-notices/settings', { lead_days: 3 })).status, 400);
  assert.match((await put('/consent-notices/settings', { body: '{{nmae}}님' })).body.error, /unknown placeholder/);
  delete process.env.AWB_PUBLIC_URL;
  const noUrl = await put('/consent-notices/settings', { enabled: true });
  assert.equal(noUrl.status, 409);
  assert.match(noUrl.body.error, /AWB_PUBLIC_URL/);
  process.env.AWB_PUBLIC_URL = base;
  const preview = await post('/consent-notices/preview', { on_no_response: 'lapse', body: '{{name}}님, {{sender}}입니다.' });
  assert.equal(preview.status, 200, preview.text);
  assert.deepEqual(preview.body.warnings, []);
  assert.equal(preview.body.sender.channel_id, early.id, 'the first email channel signs the preview');
  assert.match(preview.body.subject, /^\[AWB Team\] /);
  assert.match(preview.body.text, /^홍길동님, AWB Team입니다\.\n\n--\n/);
  assert.match(preview.body.text, /까지 동의를 유지해 주세요/);
  assert.equal((await api('/consent-notices/settings')).body.settings.on_no_response, 'keep', 'a preview saves nothing');
  const saved = await put('/consent-notices/settings', { enabled: true, lead_days: 30, on_no_response: 'keep' });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.body.settings.enabled, true);
  assert.equal(saved.body.settings.version, 1);
  const auditRepo = ds.getRepository('MarketingAuditEvent');
  const audits = await auditRepo.find({ where: { account_id: account.id, action: 'consent_notice.settings' } });
  assert.equal(audits.length, 1);
  assert.match(audits[0].summary, /켬 · 기한 30일 전 · 무응답 유지/);
  assert.equal(audits[0].detail.subject, saved.body.settings.subject, 'the audit keeps the wording of each version');
  assert.equal(audits[0].detail.body, saved.body.settings.body);

  // 2. 연락처 — 기한 = 동의 + 729 일. 안내 창은 기한 30 일 전부터.
  const imported = await post('/contacts/import', { contacts: [
    { email: 'kim@example.com', name: '김민지', lists: ['early access'], country: 'KR', ...evidence, consent_at: consentFor(10) },
    { email: 'bob@example.com', name: 'Bob', lists: ['early access'], country: 'US', timezone: 'America/New_York', ...evidence, consent_at: consentFor(40) },
    { email: 'lee@example.com', name: '이수', lists: ['beta'], ...evidence, consent_at: consentFor(12) },
    { email: 'old@example.com', name: 'Old', lists: ['early access'], ...evidence, consent_at: consentFor(-5) },
    { email: 'gone@example.com', name: 'Gone', lists: ['early access'], ...evidence, consent_at: consentFor(8) },
    { email: 'orphan@example.com', name: 'Orphan', lists: ['no channel'], ...evidence, consent_at: consentFor(20) },
  ] });
  assert.equal(imported.body.created, 6, imported.text);
  const [kim, bob, lee, old, gone, orphan] = await Promise.all(
    ['kim', 'bob', 'lee', 'old', 'gone', 'orphan'].map((n) => byEmail(`${n}@example.com`)),
  );
  await post(`/contacts/${gone.id}/unsubscribe`, { note: 'asked by phone' });
  const kimDeadline = new Date(new Date(kim.consent_at).getTime() + CONSENT_MAX_AGE_MS);

  let overview = (await api('/consent-notices/settings')).body.counts;
  assert.equal(overview.in_window, 3, JSON.stringify(overview)); // kim · lee · orphan
  assert.equal(overview.not_yet_queued, 3);
  assert.equal(overview.expired, 1, 'old has already lapsed — a notice cannot revive it');

  // 3. 줄 세우기 — 한 번만
  assert.equal(await notices.plan(new Date()), 3);
  assert.equal(await notices.plan(new Date()), 0, 'one notice per contact and deadline');
  for (const c of [bob, old, gone]) assert.equal(await noticeOf(c), null, `${c.email} gets no notice`);

  // 4. 보내기 — 서울 12시
  const noon = nextLocalHour(new Date(), 'Asia/Seoul', 12);
  assert.deepEqual(await notices.processQueue(noon), { sent: 2, deferred: 1, failed: 0, skipped: 0 });
  const kimNotice = await noticeOf(kim);
  const kimMail = sent.find((m) => m.body.to[0] === 'kim@example.com');
  assert.ok(kimMail, 'kim got the notice');
  assert.equal(kimMail.url, 'https://api.resend.com/emails');
  assert.equal(kimMail.idem, kimNotice.id, 'the notice id is the idempotency key');
  assert.deepEqual(kimMail.body.tags, [{ name: 'awb_send_id', value: kimNotice.id }], 'provider events come back to the notice row');
  assert.equal(kimMail.body.from, '"AWB Team" <hello@awb.example.com>');
  assert.equal(kimMail.body.subject, '[AWB Team] 광고성 정보 수신 동의 확인 안내 / Your email consent');
  assert.ok(!kimMail.body.subject.includes('(광고)'), 'a legal notice carries no ad label');
  assert.match(kimMail.body.text, /안녕하세요, 김민지님\. AWB Team입니다\./);
  assert.match(kimMail.body.text, new RegExp(`${escapeRe(base)}/api/m/c/${kimNotice.token}`), 'keep link');
  assert.match(kimMail.body.text, new RegExp(`${escapeRe(base)}/api/m/u/${kim.unsubscribe_token}`), 'withdraw = the unsubscribe link');
  assert.match(kimMail.body.text, /아무것도 하지 않으셔도 됩니다/);
  assert.equal(kimMail.body.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  const leeMail = sent.find((m) => m.body.to[0] === 'lee@example.com');
  assert.equal(leeMail.body.from, '"AWB Team" <beta@awb.example.com>', 'the channel of the contact\'s list signs it');
  assert.equal(kimNotice.status, 'sent');
  assert.equal(kimNotice.policy, 'keep');
  assert.equal(kimNotice.settings_version, 1);
  assert.equal(kimNotice.channel_id, early.id);
  assert.equal(kimNotice.credential_id, cred.id);
  const orphanNotice = await noticeOf(orphan);
  assert.equal(orphanNotice.status, 'deferred');
  assert.match(orphanNotice.error, /^deferred: no email channel/);

  // keep 으로 나갔다 — 보낼 때가 아니라 기한에 그 기한부터 잇는다. 원래 기한을 넘겨도 보낸다.
  assert.equal((await env.consentOf({ id: kim.id })).consent_renewed_at, null, 'not renewed when the notice goes out');
  assert.equal(await notices.renewDue(new Date(kimDeadline.getTime() - 2 * 60 * MINUTE)), 0, 'not yet');
  assert.equal(await notices.renewDue(new Date(kimDeadline.getTime() - 30 * MINUTE)), 1);
  const kimAfter = await env.consentOf({ id: kim.id });
  assert.equal(new Date(kimAfter.consent_renewed_at).getTime(), kimDeadline.getTime(), 'renewed from the deadline, not from the notice');
  assert.equal(new Date(kimAfter.consent_at).getTime(), new Date(kim.consent_at).getTime(), 'the consent date itself does not move');
  assert.ok((await noticeOf(kim)).renewed_at);
  assert.equal(await notices.renewDue(new Date(kimDeadline.getTime() - 20 * MINUTE)), 0, 'once');
  const afterKimDeadline = new Date(kimDeadline.getTime() + DAY);
  const eligible = await contactsService.eligible(account.id, 'early access', afterKimDeadline, env.brand.id);
  assert.ok(eligible.contacts.some((c) => c.id === kim.id), 'kim stays eligible past the original deadline');
  overview = (await api('/consent-notices/settings')).body.counts;
  assert.equal(overview.sent_30d, 2);
  assert.equal(overview.waiting, 1);
  assert.equal(overview.waiting_no_sender, 1);
  assert.equal(overview.not_yet_queued, 0);

  // 사람용 REST — 주소는 싣고 토큰은 내리지 않는다.
  const listed = await api('/consent-notices?status=sent');
  assert.equal(listed.status, 200, listed.text);
  assert.deepEqual(listed.body.map((n) => n.contact_email).sort(), ['kim@example.com', 'lee@example.com']);
  assert.ok(!listed.text.includes(kimNotice.token), 'keep tokens never leave the server');
  assert.equal((await api('/consent-notices?status=bogus')).status, 400);
  const contactsJson = await api('/contacts?list=early%20access&brand_id=' + env.brand.id);
  const kimJson = contactsJson.body.contacts.find((c) => c.id === kim.id).consents.find((c) => c.brand_id === env.brand.id);
  assert.equal(kimJson.consent_notice.status, 'sent');
  assert.ok(kimJson.consent_notice.renewed_at);
  assert.equal(new Date(kimJson.consent_due_at).getTime(), kimDeadline.getTime() + CONSENT_MAX_AGE_MS, 'the due date shows the renewal');
  assert.ok(!contactsJson.text.includes(kimNotice.token));

  // 5. 유지 링크 — GET 은 아무것도 바꾸지 않는다.
  const confirm = await fetch(`${base}/api/m/c/${kimNotice.token}`);
  const confirmHtml = await confirm.text();
  assert.equal(confirm.status, 200);
  assert.match(confirmHtml, /<form method="post">/);
  assert.ok(!confirmHtml.includes('kim@example.com'));
  assert.equal((await env.consentOf({ id: kim.id })).consent_method, 'signup_form', 'GET changes nothing (mail scanners open links)');
  const bogus = await (await fetch(`${base}/api/m/c/${'x'.repeat(43)}`, { method: 'POST' })).text();
  assert.match(bogus, /처리할 수 없는 링크/);
  const before = Date.now();
  const kept = await (await fetch(`${base}/api/m/c/${kimNotice.token}`, { method: 'POST' })).text();
  assert.match(kept, /수신 동의 유지됨/);
  const kimKept = await env.consentOf({ id: kim.id });
  assert.ok(new Date(kimKept.consent_at).getTime() >= before - 1000, 'a keep click is a new consent, dated now');
  assert.equal(kimKept.consent_method, 'reconfirm');
  assert.equal(kimKept.consent_source, `consent-notice:${kimNotice.id}`);
  assert.equal(kimKept.consent_text_version, 'consent-notice-v1');
  assert.equal(kimKept.consent_renewed_at, null, 'the period counts again from the click');
  assert.ok((await noticeRepo.findOneBy({ id: kimNotice.id })).kept_at);
  const again = await (await fetch(`${base}/api/m/c/${kimNotice.token}`, { method: 'POST' })).text();
  assert.match(again, /수신 동의 유지됨/);
  assert.equal(new Date((await env.consentOf({ id: kim.id })).consent_at).getTime(), new Date(kimKept.consent_at).getTime(),
    'pressing it twice keeps once');
  const keptAudit = await auditRepo.find({ where: { entity_id: kim.id, action: 'contact.consent_kept' } });
  assert.equal(keptAudit.length, 1);
  assert.equal(keptAudit[0].detail.previous.consent_method, 'signup_form', 'the earlier evidence stays in the audit log');

  // 철회는 수신거부 링크 그대로 — 그 뒤의 유지 클릭은 되살리지 않는다.
  const leeNotice = await noticeOf(lee);
  await fetch(`${base}/api/m/u/${lee.unsubscribe_token}`, { method: 'POST' });
  assert.equal((await env.consentOf({ id: lee.id })).status, 'unsubscribed');
  assert.match(await (await fetch(`${base}/api/m/c/${leeNotice.token}`, { method: 'POST' })).text(), /처리할 수 없는 링크/);
  assert.equal((await env.consentOf({ id: lee.id })).status, 'unsubscribed', 'a keep link does not resubscribe');

  // 두 번째 주기 — 이미 한 번 이어진 동의도 다음 기한에서 다시 이어진다(기산일은 계속 원래 주기를 따른다).
  const firstDue = new Date(Date.now() + 10 * DAY - CONSENT_MAX_AGE_MS);
  await post('/contacts/import', { contacts: [
    { email: 'second@example.com', name: '두번째', lists: ['early access'], ...evidence, consent_at: new Date(firstDue.getTime() - CONSENT_MAX_AGE_MS).toISOString() },
  ] });
  const second = await byEmail('second@example.com');
  await env.consentRepo.update({ contact_id: second.id, brand_id: env.brand.id }, { consent_renewed_at: firstDue });
  assert.equal(await notices.plan(new Date()), 1);
  assert.equal((await notices.processQueue(noon)).sent, 1);
  const secondDue = new Date(firstDue.getTime() + CONSENT_MAX_AGE_MS);
  assert.equal(new Date((await noticeOf(second)).due_at).getTime(), secondDue.getTime());
  assert.equal(await notices.renewDue(new Date(secondDue.getTime() - 30 * MINUTE)), 1);
  assert.equal(new Date((await env.consentOf({ id: second.id })).consent_renewed_at).getTime(), secondDue.getTime(),
    'the renewal moves on to the next deadline');

  // 안내 기간 중에 새 동의가 들어왔다 — 기한에 잇지 않는다(새 동의가 다음 주기를 정한다).
  await post('/contacts/import', { contacts: [{ email: 'win@example.com', name: '중간', lists: ['early access'], ...evidence, consent_at: consentFor(11) }] });
  const win = await byEmail('win@example.com');
  const winDeadline = new Date(new Date(win.consent_at).getTime() + CONSENT_MAX_AGE_MS);
  await notices.plan(new Date());
  await notices.processQueue(noon);
  assert.equal((await noticeOf(win)).status, 'sent');
  const winReconsent = new Date().toISOString();
  assert.equal((await post('/contacts/import', { contacts: [{ email: 'win@example.com', lists: ['early access'], ...evidence, consent_at: winReconsent }] })).body.updated, 1);
  await notices.renewDue(new Date(winDeadline.getTime() - 30 * MINUTE));
  const winAfter = await env.consentOf({ id: win.id });
  assert.equal(winAfter.consent_renewed_at, null, 'a consent given during the window is not overridden');
  assert.equal(new Date(winAfter.consent_at).getTime(), new Date(winReconsent).getTime(), 'the period counts from the new consent');

  // 6. lapse — 무응답이면 기한에 빠진다. 문구 version 이 오른다.
  const lapse = await put('/consent-notices/settings', { on_no_response: 'lapse' });
  assert.equal(lapse.body.settings.version, 2);
  await post('/contacts/import', { contacts: [
    { email: 'mina@example.com', name: '미나', lists: ['early access'], ...evidence, consent_at: consentFor(15) },
    { email: 'jun@example.com', name: '준', lists: ['early access'], ...evidence, consent_at: consentFor(16) },
    { email: 'late@example.com', name: '늦음', lists: ['early access'], ...evidence, consent_at: consentFor(1) },
    { email: 'reject@example.com', name: '거절', lists: ['early access'], ...evidence, consent_at: consentFor(17) },
  ] });
  const [mina, jun, late, reject] = await Promise.all(['mina', 'jun', 'late', 'reject'].map((n) => byEmail(`${n}@example.com`)));
  assert.equal(await notices.plan(new Date()), 4);
  // 보내기 전에 jun 이 새로 동의했다(기한이 바뀜) → 이 주기의 안내는 필요 없다.
  const renewedJun = await post('/contacts/import', { contacts: [{ email: 'jun@example.com', lists: ['early access'], ...evidence, consent_at: new Date().toISOString() }] });
  assert.equal(renewedJun.body.updated, 1, renewedJun.text);
  // late 는 보내기 전에 기한이 지났다.
  const lateDeadline = new Date(new Date(late.consent_at).getTime() + CONSENT_MAX_AGE_MS);
  await noticeRepo.update({ contact_id: late.id }, { next_attempt_at: new Date(lateDeadline.getTime() + MINUTE) });
  replies.length = 0;
  const sentBefore = sent.length;
  // 공급자 응답은 기한이 가까운 것부터 — mina(15일) 다음 reject(17일).
  replies.push({ status: 200, body: { id: 're_mina' } }, { status: 422, body: { message: 'invalid recipient' } });
  const lapseRun = await notices.processQueue(noon);
  assert.equal(lapseRun.sent, 1, JSON.stringify(lapseRun));
  assert.equal(lapseRun.failed, 1);
  assert.equal(lapseRun.skipped, 1, 'jun renewed meanwhile');
  const minaMail = sent.slice(sentBefore).find((m) => m.body.to[0] === 'mina@example.com');
  assert.match(minaMail.body.text, /까지 동의를 유지해 주세요/);
  const minaNotice = await noticeOf(mina);
  assert.equal(minaNotice.policy, 'lapse');
  assert.equal(minaNotice.settings_version, 2);
  const minaDeadline = new Date(new Date(mina.consent_at).getTime() + CONSENT_MAX_AGE_MS);
  await notices.renewDue(new Date(minaDeadline.getTime() - 30 * MINUTE));
  assert.equal((await env.consentOf({ id: mina.id })).consent_renewed_at, null, 'lapse does not renew');
  const afterMina = await contactsService.eligible(account.id, 'early access', new Date(minaDeadline.getTime() + MINUTE), env.brand.id);
  assert.ok(!afterMina.contacts.some((c) => c.id === mina.id), 'no keep click → out on the deadline');
  assert.match((await noticeOf(jun)).error, /renewed meanwhile/);
  assert.equal((await noticeOf(reject)).status, 'failed');
  assert.match((await noticeOf(reject)).error, /HTTP 422/);
  await notices.processQueue(new Date(lateDeadline.getTime() + 2 * MINUTE));
  assert.match((await noticeOf(late)).error, /deadline passed/);
  assert.equal(sent.filter((m) => m.body.to[0] === 'late@example.com').length, 0, 'never sent after the deadline');

  // 유지 링크는 행의 상태와 무관하다(토큰은 안내 메일에만 있다) — 동시에 두 번 눌러도 한 번, 기한 30 일 뒤에는 받지 않는다.
  const [k1, k2] = await Promise.all([1, 2].map(() => fetch(`${base}/api/m/c/${minaNotice.token}`, { method: 'POST' }).then((r) => r.text())));
  assert.match(k1, /수신 동의 유지됨/);
  assert.match(k2, /수신 동의 유지됨/);
  assert.equal((await auditRepo.find({ where: { entity_id: mina.id, action: 'contact.consent_kept' } })).length, 1, 'concurrent clicks keep once');
  assert.equal((await env.consentOf({ id: mina.id })).consent_method, 'reconfirm');
  const rejectNotice = await noticeOf(reject);
  assert.equal((await notices.keep(rejectNotice.token, new Date(new Date(rejectNotice.due_at).getTime() + 31 * DAY))).kept, false,
    'not 30 days after the deadline');
  assert.equal((await notices.keep(rejectNotice.token)).kept, true, 'a failed row may still have been delivered');
  assert.equal((await env.consentOf({ id: reject.id })).consent_method, 'reconfirm');

  // 7. 일시 오류는 3 번까지, 공급자 거절은 failed — 사람이 기한 전에 다시 보낸다.
  await post('/contacts/import', { contacts: [{ email: 'retry@example.com', name: '재시도', lists: ['early access'], ...evidence, consent_at: consentFor(25) }] });
  const retry = await byEmail('retry@example.com');
  await notices.plan(new Date());
  replies.length = 0;
  replies.push({ status: 503, body: { message: 'busy' } }, { status: 503, body: { message: 'busy' } }, { status: 503, body: { message: 'busy' } });
  await notices.processQueue(noon);
  assert.deepEqual([(await noticeOf(retry)).status, (await noticeOf(retry)).attempts], ['deferred', 1]);
  await notices.processQueue(new Date(noon.getTime() + 11 * MINUTE));
  assert.deepEqual([(await noticeOf(retry)).status, (await noticeOf(retry)).attempts], ['deferred', 2]);
  await notices.processQueue(new Date(noon.getTime() + 32 * MINUTE));
  assert.deepEqual([(await noticeOf(retry)).status, (await noticeOf(retry)).attempts], ['failed', 3]);
  // retry 와 앞서 422 로 거절된 reject — 둘 다 기한 전이다(stuck · late 는 아니다).
  assert.equal((await api('/consent-notices/settings')).body.counts.failed_retryable, 2);
  const retried = await post('/consent-notices/retry-failed');
  assert.equal(retried.status, 200, retried.text);
  assert.equal(retried.body.requeued, 2);
  assert.equal(retried.body.counts.failed_retryable, 0);
  assert.equal((await auditRepo.find({ where: { account_id: account.id, action: 'consent_notice.retry' } })).length, 1);
  await notices.processQueue(new Date(noon.getTime() + 33 * MINUTE));
  assert.equal((await noticeOf(retry)).status, 'sent');
  assert.match((await noticeOf(reject)).error, /renewed meanwhile/, 'reject has kept its consent since — no notice needed');

  // 보내던 중 끊긴 행은 다시 보내지 않는다.
  await post('/contacts/import', { contacts: [{ email: 'stuck@example.com', name: '끊김', lists: ['early access'], ...evidence, consent_at: consentFor(26) }] });
  const stuck = await byEmail('stuck@example.com');
  await notices.plan(new Date());
  await noticeRepo.update({ contact_id: stuck.id }, { status: 'sending', next_attempt_at: new Date(Date.now() + DAY) });
  await notices.processQueue(new Date(Date.now() + 11 * MINUTE));
  assert.equal((await noticeOf(stuck)).status, 'failed');
  assert.match((await noticeOf(stuck)).error, /interrupted while sending/);

  // 8. 수신자 현지 야간이면 아침으로 — 기한을 넘기지 않는 한.
  await post('/contacts/import', { contacts: [{ email: 'yuna@example.com', name: '유나', lists: ['early access'], ...evidence, consent_at: consentFor(20) }] });
  const yuna = await byEmail('yuna@example.com');
  await notices.plan(new Date());
  const night = nextLocalHour(new Date(), 'Asia/Seoul', 23);
  await notices.processQueue(night);
  const yunaNight = await noticeOf(yuna);
  assert.equal(yunaNight.status, 'deferred');
  assert.equal(localHour(yunaNight.next_attempt_at, 'Asia/Seoul'), 8);
  await notices.processQueue(new Date(new Date(yunaNight.next_attempt_at).getTime() + MINUTE));
  assert.equal((await noticeOf(yuna)).status, 'sent');

  // 9. 끄면 새로 줄 세우지 않고, 남은 안내도 보내지 않는다.
  await put('/consent-notices/settings', { enabled: false });
  await post('/contacts/import', { contacts: [{ email: 'off@example.com', name: 'Off', lists: ['early access'], ...evidence, consent_at: consentFor(9) }] });
  assert.equal(await notices.plan(new Date()), 0);
  await noticeRepo.update({ contact_id: orphan.id }, { next_attempt_at: new Date(noon.getTime() - 1000) });
  await notices.processQueue(noon);
  assert.match((await noticeOf(orphan)).error, /turned off/);
});

test('consent notice events: complaints, bounces and mailto withdrawals reach contacts who only got the notice', async (t) => {
  const whsec = `whsec_${randomBytes(24).toString('base64')}`;
  const env = await setup(t, 'mkt-consent-hooks', { webhook_secret: whsec });
  const { app, base, notices, sent, put, post, cred, byEmail, noticeOf, contactRepo, ds } = env;
  await env.approveEmail('news', 'AWB Team', 'hello@awb.example.com');
  const events = app.get(MarketingEmailEventsService);
  const inbox = new Map();
  const inboxCalls = [];
  events.fetchImpl = async (url) => {
    inboxCalls.push(url);
    const r = inbox.get(decodeURIComponent(url.split('/').pop())) || { status: 404, body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status });
  };
  const hook = (payload) => {
    const raw = Buffer.from(JSON.stringify(payload));
    const id = `msg_${randomUUID()}`;
    const ts = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', Buffer.from(whsec.replace(/^whsec_/, ''), 'base64')).update(`${id}.${ts}.`).update(raw).digest('base64');
    return call(`${base}/api/m/email/${cred.id}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${sig}` },
      body: raw,
    });
  };

  await put('/consent-notices/settings', { enabled: true, on_no_response: 'keep' });
  const names = ['spam', 'hard', 'soft', 'quiet', 'chatty'];
  await post('/contacts/import', { contacts: names.map((n) => ({ email: `${n}@example.com`, name: n, lists: ['news'], ...evidence, consent_at: consentFor(10) })) });
  const contacts = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await byEmail(`${n}@example.com`)])));
  assert.equal(await ds.getRepository('MarketingEmailSend').count({ where: { account_id: env.account.id } }), 0, 'nobody here ever got a campaign mail');
  await notices.plan(new Date());
  await notices.processQueue(nextLocalHour(new Date(), 'Asia/Seoul', 12));
  // (Postgres 매트릭스에서는 같은 파일의 앞 테스트와 스키마를 같이 쓴다 — 전체 수가 아니라 이 연락처들로 본다.)
  const row = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await noticeOf(contacts[n])])));
  assert.deepEqual(names.map((n) => row[n].status), names.map(() => 'sent'));

  // 스팸 신고(tag 로) → 연락처 억제, 안내 행에 사유.
  const at = new Date().toISOString();
  const complained = await hook({ type: 'email.complained', created_at: at, data: { email_id: row.spam.provider_message_id, to: ['spam@example.com'], tags: { awb_send_id: row.spam.id } } });
  assert.equal(complained.status, 200, complained.text);
  assert.equal(complained.body.applied, 1, complained.text);
  assert.equal((await contactRepo.findOneBy({ id: contacts.spam.id })).status, 'complained');
  assert.equal((await noticeOf(contacts.spam)).event_note, 'spam complaint');
  const audit = await ds.getRepository('MarketingAuditEvent').findOneBy({ entity_id: contacts.spam.id, action: 'contact.complained' });
  assert.equal(audit.detail.consent_notice_id, row.spam.id);

  // 하드 바운스(tag 없이 message id 로) → bounced. 소프트 바운스 → 연락처는 그대로지만 닿지 않은 안내로는 잇지 않는다.
  const bounce = (n, type) => ({ type: 'email.bounced', created_at: at, data: { email_id: row[n].provider_message_id, to: [`${n}@example.com`], bounce: { type, subType: 'General', message: 'mailbox unavailable' } } });
  assert.equal((await hook(bounce('hard', 'Permanent'))).body.applied, 1);
  assert.equal((await contactRepo.findOneBy({ id: contacts.hard.id })).status, 'bounced');
  assert.equal((await noticeOf(contacts.hard)).bounce_type, 'hard');
  assert.equal((await hook(bounce('soft', 'Transient'))).body.applied, 1);
  assert.equal((await contactRepo.findOneBy({ id: contacts.soft.id })).status, 'subscribed');
  assert.equal((await noticeOf(contacts.soft)).bounce_type, 'soft');

  // mailto 수신거부(List-Unsubscribe) — 안내만 받은 사람의 것도 처리하고, 처리 안내를 안내의 채널로 보낸다.
  const received = (id, from, subject) => ({ type: 'email.received', created_at: at, data: { email_id: id, from, to: ['help@awb.example.com'], subject, message_id: `<${id}@mail.example.com>` } });
  inbox.set('in_quiet', { status: 200, body: { from: 'quiet@example.com', subject: 'unsubscribe ' + contacts.quiet.unsubscribe_token, text: '' } });
  const unsub = await hook(received('in_quiet', 'quiet@example.com', 'unsubscribe ' + contacts.quiet.unsubscribe_token));
  assert.equal(unsub.body.reply, 'unsubscribed', unsub.text);
  const quietAfter = await env.consentOf(contacts.quiet);
  assert.deepEqual([quietAfter.status, quietAfter.unsubscribe_source], ['unsubscribed', 'mailto']);
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(sent.some((m) => m.body.to[0] === 'quiet@example.com' && /수신거부 처리 안내/.test(m.body.subject)), 'the withdrawal is confirmed');
  // 안내 자유 회신은 계정 회신함에만 보관한다. 모르는 사람의 메일은 열지도 않는다.
  inbox.set('in_chatty', { status: 200, body: { from: 'chatty@example.com', subject: 'Re: consent', text: '그만 보내 주세요. chatty@example.com\n\nOn Tuesday someone wrote:\n> quoted secret' } });
  assert.equal((await hook(received('in_chatty', 'chatty@example.com', 'Re: consent'))).body.reply, 'recorded');
  assert.equal((await hook(received('in_chatty', 'chatty@example.com', 'Re: consent'))).body.reply, 'duplicate');
  const replies = await env.api('/contacts/replies');
  assert.equal(replies.status, 200, replies.text);
  assert.equal(replies.body.total, 1);
  const reply = replies.body.replies[0];
  assert.equal(reply.contact_id, contacts.chatty.id);
  assert.equal(reply.notice_id, row.chatty.id);
  assert.equal(reply.brand_id, env.brand.id);
  assert.match(reply.content, /그만 보내 주세요/);
  assert.doesNotMatch(reply.content, /chatty@example|quoted secret/);
  assert.equal(reply.contact.email, 'chatty@example.com');
  assert.equal(reply.source_key, undefined);
  assert.equal((await env.api('/contacts/replies?offset=50')).body.replies.length, 0);
  assert.equal((await env.consentOf(contacts.chatty)).status, 'subscribed', 'free prose does not automatically change consent');
  assert.equal(await ds.getRepository('MarketingFeedback').count({ where: { account_id: env.account.id } }), 0, 'notice replies never enter campaign feedback/agent inputs');
  inbox.set('in_auto', { status: 200, body: { from: 'chatty@example.com', subject: 'Automatic reply', text: 'Away' } });
  assert.equal((await hook(received('in_auto', 'chatty@example.com', 'Automatic reply'))).body.reply, 'ignored');
  inbox.set('in_empty', { status: 200, body: { from: 'chatty@example.com', subject: 'Re: consent', text: '> only quoted content' } });
  assert.equal((await hook(received('in_empty', 'chatty@example.com', 'Re: consent'))).body.reply, 'ignored');
  const outsider = await createUser(app, env.modules.getDataSourceToken, { name: 'mkt-replies-outsider', role: 'admin' });
  const other = await createAccount(app, env.modules.getDataSourceToken, 'mkt-replies-other', { ownerUserId: outsider.id });
  const otherHeaders = { Authorization: `Bearer ${app.get(env.modules.AuthService).createSession(outsider.id)}`, 'X-Account-Id': other.id };
  const otherList = await call(`${base}/api/marketing/contacts/replies`, { headers: otherHeaders });
  assert.equal(otherList.status, 200, otherList.text);
  assert.equal(otherList.body.total, 0);
  const denied = await call(`${base}/api/marketing/contacts/replies?account_id=${env.account.id}`, { headers: otherHeaders });
  assert.equal(denied.status, 403, denied.text);
  const callsBefore = inboxCalls.length;
  assert.equal((await hook(received('in_stranger', 'stranger@example.com', 'unsubscribe'))).body.reply, 'ignored');
  assert.equal(inboxCalls.length, callsBefore, 'a stranger\'s mail is not read');

  // 기한 — 신고 · 바운스 · 철회 · 닿지 않은 안내는 잇지 않고, 닿은 안내(chatty)만 잇는다.
  const deadline = new Date(new Date(contacts.chatty.consent_at).getTime() + CONSENT_MAX_AGE_MS);
  await notices.renewDue(new Date(deadline.getTime() - 30 * MINUTE));
  assert.ok((await env.consentOf(contacts.chatty)).consent_renewed_at);
  for (const n of ['spam', 'hard', 'quiet']) {
    assert.equal((await env.consentOf(contacts[n])).consent_renewed_at, null, `${n} is not renewed`);
  }
  assert.equal((await env.consentOf(contacts.soft)).consent_renewed_at, null, 'an undelivered notice does not renew');
});
