// Marketing 수신 동의 재확인 안내 — docs/marketing.md "동의 재확인 안내" (정보통신망법 §50⑧ · 시행령 §62의3).
//
// 고정하는 것:
//   1. 설정은 운영자가 정한다(marketing.manage): 기본은 꺼짐 · 기본 문구. 범위 밖 발송 시점 · 모르는 자리표시자는 400,
//      AWB_PUBLIC_URL 없이 켜면 409. 문구 · 무응답 처리를 바꾸면 version 이 오르고 감사에 남는다. 미리보기는 실제로 나갈 모양이다.
//   2. 줄 세우기: 켠 계정의 subscribed 연락처 가운데 기한 lead_days 일 안에 든 사람만, (연락처, 기한)마다 한 번.
//      기한이 이미 지난 동의 · 수신거부한 사람에게는 보내지 않는다.
//   3. 보내기: 발신자는 그 사람의 목록을 쓰는 메일 채널(최근 받은 메일의 채널이 먼저). 채널이 없으면 미룬다. 광고 표기 없이
//      법정 항목 · 유지/철회 링크가 들어 있고, 공급자에 안내 행 id 가 멱등 키로 간다. 수신자 현지 야간이면 아침으로 미룬다.
//      보내기 직전에 새 동의(기한이 바뀜) · 기한 지남이면 건너뛴다. 공급자가 거절하면 failed.
//   4. 무응답 처리: keep 으로 나갔으면 그 기한부터 다시 2 년(원래 기한을 넘겨도 발송 대상). lapse 면 기한에 빠진다.
//   5. 유지 링크: GET 은 아무것도 바꾸지 않는다. POST 는 새 동의(동의일 = 지금, method reconfirm, 이어진 기간은 지움)이고
//      두 번 눌러도 한 번이다. 수신거부한 사람은 되살리지 않는다. 철회는 수신거부 링크 그대로다. 토큰은 REST 에 나가지 않는다.
//
// 실행: node --test --test-force-exit test/marketing-consent-notice.test.mjs (dist 필요)

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAccount, createAgent, createUser } from './helpers/fixtures.mjs';
import { encrypt } from '../dist/services/encryption.service.js';
import { MarketingEmailService } from '../dist/modules/marketing/marketing-email.service.js';
import { MarketingContactService } from '../dist/modules/marketing/marketing-contact.service.js';
import { MarketingConsentNoticeService } from '../dist/modules/marketing/marketing-consent-notice.service.js';
import { CONSENT_MAX_AGE_MS, localHour } from '../dist/common/marketing/email.js';

process.env.PORT = process.env.TEST_SERVER_PORT || '0';
process.env.AGENT_DEV_MODE = 'false';
process.env.MARKETING_SCHEDULER_ENABLED = 'false';
process.env.OUTREACH_SCHEDULER_ENABLED = 'false';

const DAY = 24 * 60 * 60_000;

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

test('consent reconfirmation notices: settings, queue, keep and lapse, keep link, withdraw', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(async () => { await closeTestApp(app); delete process.env.AWB_PUBLIC_URL; });
  const { getDataSourceToken, AuthService } = modules;
  const ds = app.get(getDataSourceToken());
  const base = `http://127.0.0.1:${port}`;
  process.env.AWB_PUBLIC_URL = base;

  const notices = app.get(MarketingConsentNoticeService);
  const contactsService = app.get(MarketingContactService);
  const sent = [];
  const replies = [];
  const capture = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ url, body, idem: init.headers['idempotency-key'] });
    const reply = replies.shift() || { status: 200, body: { id: `re_${sent.length}` } };
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  };
  notices.fetchImpl = capture;
  app.get(MarketingEmailService).fetchImpl = capture;

  const account = await createAccount(app, getDataSourceToken, 'mkt-consent');
  const admin = await createUser(app, getDataSourceToken, { name: 'mkt-consent-admin', role: 'admin' });
  const plain = await createUser(app, getDataSourceToken, { name: 'mkt-consent-plain', role: 'user' });
  const H = { Authorization: `Bearer ${app.get(AuthService).createSession(admin.id)}`, 'X-Account-Id': account.id, 'Content-Type': 'application/json' };
  const api = (path, init = {}) => call(`${base}/api/marketing${path}`, { headers: H, ...init });
  const post = (path, body = {}) => api(path, { method: 'POST', body: JSON.stringify(body) });
  const put = (path, body = {}) => api(path, { method: 'PUT', body: JSON.stringify(body) });

  // 메일 채널 둘 — 목록 "early access"(AWB Team), "beta"(Beta Team).
  const agent = await createAgent(app, getDataSourceToken, account.id, { name: 'mkt-consent-agent', type: 'claude', runtime: true });
  const campaign = (await post('/campaigns', { name: 'Consent', agent_runtime: agent.runtime_spec, capabilities: ['email'] })).body;
  await post(`/campaigns/${campaign.id}/status`, { status: 'active' });
  const credRepo = ds.getRepository('Credential');
  const cred = await credRepo.save(credRepo.create({
    account_id: account.id, name: 'resend', description: '', provider: 'custom', encrypted_data: encrypt(JSON.stringify({ provider: 'resend', api_key: 're_secret_key' })),
  }));
  const approveEmail = async (target, fromName, from) => {
    const proposed = (await post(`/campaigns/${campaign.id}/channels`, { platform: 'email', target })).body;
    const approved = await post(`/channels/${proposed.id}/approve`, { mode: 'email', email: {
      credential_id: cred.id, from_name: fromName, from_address: from, reply_to: '', postal_address: '1 Main St, Seoul', contact_email: 'help@awb.example.com', list_name: target,
    } });
    assert.equal(approved.body.status, 'active', approved.text);
    return approved.body;
  };
  const early = await approveEmail('early access', 'AWB Team', 'hello@awb.example.com');
  const beta = await approveEmail('beta', 'Beta Team', 'beta@awb.example.com');

  // 1. 설정
  assert.equal((await call(`${base}/api/marketing/consent-notices/settings`, {
    headers: { ...H, Authorization: `Bearer ${app.get(AuthService).createSession(plain.id)}` },
  })).status, 403, 'marketing.manage only');
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
  const audits = await ds.getRepository('MarketingAuditEvent').find({ where: { account_id: account.id, action: 'consent_notice.settings' } });
  assert.equal(audits.length, 1);
  assert.match(audits[0].summary, /켬 · 기한 30일 전 · 무응답 유지/);

  // 2. 연락처 — 기한 = 동의 + 730 일. 안내 창은 기한 30 일 전부터.
  const consentFor = (deadlineInDays) => new Date(Date.now() - CONSENT_MAX_AGE_MS + deadlineInDays * DAY).toISOString();
  const evidence = { consent_method: 'signup_form', consent_source: 'https://awb.example.com/signup' };
  const imported = await post('/contacts/import', { contacts: [
    { email: 'kim@example.com', name: '김민지', lists: ['early access'], country: 'KR', ...evidence, consent_at: consentFor(10) },
    { email: 'bob@example.com', name: 'Bob', lists: ['early access'], country: 'US', timezone: 'America/New_York', ...evidence, consent_at: consentFor(40) },
    { email: 'lee@example.com', name: '이수', lists: ['beta'], ...evidence, consent_at: consentFor(12) },
    { email: 'old@example.com', name: 'Old', lists: ['early access'], ...evidence, consent_at: consentFor(-5) },
    { email: 'gone@example.com', name: 'Gone', lists: ['early access'], ...evidence, consent_at: consentFor(8) },
    { email: 'orphan@example.com', name: 'Orphan', lists: ['no channel'], ...evidence, consent_at: consentFor(20) },
  ] });
  assert.equal(imported.body.created, 6, imported.text);
  const contactRepo = ds.getRepository('MarketingContact');
  const byEmail = async (email) => contactRepo.findOneBy({ account_id: account.id, email });
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
  const noticeRepo = ds.getRepository('MarketingConsentNotice');
  const noticeOf = async (contact) => noticeRepo.findOneBy({ contact_id: contact.id });
  for (const c of [bob, old, gone]) assert.equal(await noticeOf(c), null, `${c.email} gets no notice`);

  // 4. 보내기 — 서울 12시
  const noon = nextLocalHour(new Date(), 'Asia/Seoul', 12);
  assert.deepEqual(await notices.processQueue(noon), { sent: 2, deferred: 1, failed: 0, skipped: 0 });
  const kimNotice = await noticeOf(kim);
  const kimMail = sent.find((m) => m.body.to[0] === 'kim@example.com');
  assert.ok(kimMail, 'kim got the notice');
  assert.equal(kimMail.url, 'https://api.resend.com/emails');
  assert.equal(kimMail.idem, kimNotice.id, 'the notice id is the idempotency key');
  assert.equal(kimMail.body.from, '"AWB Team" <hello@awb.example.com>');
  assert.equal(kimMail.body.subject, '[AWB Team] 광고성 정보 수신 동의 확인 안내 / Your email consent');
  assert.ok(!kimMail.body.subject.includes('(광고)'), 'a legal notice carries no ad label');
  assert.match(kimMail.body.text, /안녕하세요, 김민지님\. AWB Team입니다\./);
  assert.match(kimMail.body.text, new RegExp(`${escapeRe(base)}/api/m/c/${kimNotice.token}`), 'keep link');
  assert.match(kimMail.body.text, new RegExp(`${escapeRe(base)}/api/m/u/${kim.unsubscribe_token}`), 'withdraw = the unsubscribe link');
  assert.match(kimMail.body.text, /아무것도 하지 않으셔도 됩니다/);
  assert.equal(kimMail.body.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.ok(!kimMail.body.tags, 'not tagged as a campaign send');
  const leeMail = sent.find((m) => m.body.to[0] === 'lee@example.com');
  assert.equal(leeMail.body.from, '"Beta Team" <beta@awb.example.com>', 'the channel of the contact\'s list signs it');
  assert.equal(kimNotice.status, 'sent');
  assert.equal(kimNotice.policy, 'keep');
  assert.equal(kimNotice.settings_version, 1);
  assert.equal(kimNotice.channel_id, early.id);
  assert.equal(kimNotice.credential_id, cred.id);
  const orphanNotice = await noticeOf(orphan);
  assert.equal(orphanNotice.status, 'deferred');
  assert.match(orphanNotice.error, /^deferred: no email channel/);

  // keep 으로 나갔다 — 그 기한부터 다시 2 년, 원래 기한을 넘겨도 보낸다.
  const kimAfter = await contactRepo.findOneBy({ id: kim.id });
  assert.equal(new Date(kimAfter.consent_renewed_at).getTime(), kimDeadline.getTime(), 'renewed from the deadline, not from the notice');
  assert.equal(new Date(kimAfter.consent_at).getTime(), new Date(kim.consent_at).getTime(), 'the consent date itself does not move');
  const afterKimDeadline = new Date(kimDeadline.getTime() + DAY);
  const eligible = await contactsService.eligible(account.id, 'early access', afterKimDeadline);
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
  const contactsJson = await api('/contacts?list=early%20access');
  const kimJson = contactsJson.body.contacts.find((c) => c.id === kim.id);
  assert.equal(kimJson.consent_notice.status, 'sent');
  assert.equal(new Date(kimJson.consent_due_at).getTime(), kimDeadline.getTime() + CONSENT_MAX_AGE_MS, 'the due date shows the renewal');
  assert.ok(!contactsJson.text.includes(kimNotice.token));

  // 5. 유지 링크 — GET 은 아무것도 바꾸지 않는다.
  const confirm = await fetch(`${base}/api/m/c/${kimNotice.token}`);
  const confirmHtml = await confirm.text();
  assert.equal(confirm.status, 200);
  assert.match(confirmHtml, /<form method="post">/);
  assert.ok(!confirmHtml.includes('kim@example.com'));
  assert.equal((await contactRepo.findOneBy({ id: kim.id })).consent_method, 'signup_form', 'GET changes nothing (mail scanners open links)');
  const bogus = await (await fetch(`${base}/api/m/c/${'x'.repeat(43)}`, { method: 'POST' })).text();
  assert.match(bogus, /처리할 수 없는 링크/);
  const before = Date.now();
  const kept = await (await fetch(`${base}/api/m/c/${kimNotice.token}`, { method: 'POST' })).text();
  assert.match(kept, /수신 동의 유지됨/);
  const kimKept = await contactRepo.findOneBy({ id: kim.id });
  assert.ok(new Date(kimKept.consent_at).getTime() >= before - 1000, 'a keep click is a new consent, dated now');
  assert.equal(kimKept.consent_method, 'reconfirm');
  assert.equal(kimKept.consent_source, `consent-notice:${kimNotice.id}`);
  assert.equal(kimKept.consent_text_version, 'consent-notice-v1');
  assert.equal(kimKept.consent_renewed_at, null, 'two years count again from the click');
  assert.ok((await noticeRepo.findOneBy({ id: kimNotice.id })).kept_at);
  const again = await (await fetch(`${base}/api/m/c/${kimNotice.token}`, { method: 'POST' })).text();
  assert.match(again, /수신 동의 유지됨/);
  assert.equal(new Date((await contactRepo.findOneBy({ id: kim.id })).consent_at).getTime(), new Date(kimKept.consent_at).getTime(),
    'pressing it twice keeps once');
  const keptAudit = await ds.getRepository('MarketingAuditEvent').find({ where: { entity_id: kim.id, action: 'contact.consent_kept' } });
  assert.equal(keptAudit.length, 1);
  assert.equal(keptAudit[0].detail.previous.consent_method, 'signup_form', 'the earlier evidence stays in the audit log');

  // 철회는 수신거부 링크 그대로 — 그 뒤의 유지 클릭은 되살리지 않는다.
  const leeNotice = await noticeOf(lee);
  await fetch(`${base}/api/m/u/${lee.unsubscribe_token}`, { method: 'POST' });
  assert.equal((await contactRepo.findOneBy({ id: lee.id })).status, 'unsubscribed');
  assert.match(await (await fetch(`${base}/api/m/c/${leeNotice.token}`, { method: 'POST' })).text(), /처리할 수 없는 링크/);
  assert.equal((await contactRepo.findOneBy({ id: lee.id })).status, 'unsubscribed', 'a keep link does not resubscribe');

  // 두 번째 주기 — 이미 한 번 이어진 동의도 다음 기한에서 다시 이어진다(기산일은 계속 원래 주기를 따른다).
  const firstDue = new Date(Date.now() + 10 * DAY - CONSENT_MAX_AGE_MS);
  await post('/contacts/import', { contacts: [
    { email: 'second@example.com', name: '두번째', lists: ['early access'], ...evidence, consent_at: new Date(firstDue.getTime() - CONSENT_MAX_AGE_MS).toISOString() },
  ] });
  const second = await byEmail('second@example.com');
  await contactRepo.update({ id: second.id }, { consent_renewed_at: firstDue });
  assert.equal(await notices.plan(new Date()), 1);
  assert.equal((await notices.processQueue(noon)).sent, 1);
  const secondDue = new Date(firstDue.getTime() + CONSENT_MAX_AGE_MS);
  assert.equal(new Date((await noticeOf(second)).due_at).getTime(), secondDue.getTime());
  assert.equal(new Date((await contactRepo.findOneBy({ id: second.id })).consent_renewed_at).getTime(), secondDue.getTime(),
    'the renewal moves on to the next deadline');

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
  await noticeRepo.update({ contact_id: late.id }, { next_attempt_at: new Date(new Date(late.consent_at).getTime() + CONSENT_MAX_AGE_MS + 60_000) });
  replies.length = 0;
  const sentBefore = sent.length;
  const minaRow = await noticeOf(mina);
  // 공급자 응답은 처리 순서대로 — mina 다음 reject(4xx).
  await noticeRepo.update({ id: minaRow.id }, { next_attempt_at: new Date(noon.getTime() - 2000) });
  await noticeRepo.update({ contact_id: reject.id }, { next_attempt_at: new Date(noon.getTime() - 1000) });
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
  assert.equal((await contactRepo.findOneBy({ id: mina.id })).consent_renewed_at, null, 'lapse does not renew');
  const minaDeadline = new Date(new Date(mina.consent_at).getTime() + CONSENT_MAX_AGE_MS);
  const afterMina = await contactsService.eligible(account.id, 'early access', new Date(minaDeadline.getTime() + 60_000));
  assert.ok(!afterMina.contacts.some((c) => c.id === mina.id), 'no keep click → out on the deadline');
  assert.match((await noticeOf(jun)).error, /renewed meanwhile/);
  assert.equal((await noticeOf(reject)).status, 'failed');
  assert.match((await noticeOf(reject)).error, /HTTP 422/);
  const lateRun = await notices.processQueue(new Date(new Date(late.consent_at).getTime() + CONSENT_MAX_AGE_MS + 120_000));
  assert.ok(lateRun.skipped >= 1, JSON.stringify(lateRun));
  assert.match((await noticeOf(late)).error, /deadline passed/);
  assert.equal(sent.filter((m) => m.body.to[0] === 'late@example.com').length, 0, 'never sent after the deadline');

  // 7. 수신자 현지 야간이면 아침으로 — 기한을 넘기지 않는 한.
  await post('/contacts/import', { contacts: [{ email: 'yuna@example.com', name: '유나', lists: ['early access'], ...evidence, consent_at: consentFor(20) }] });
  const yuna = await byEmail('yuna@example.com');
  await notices.plan(new Date());
  const night = nextLocalHour(new Date(), 'Asia/Seoul', 23);
  await notices.processQueue(night);
  const yunaNight = await noticeOf(yuna);
  assert.equal(yunaNight.status, 'deferred');
  assert.equal(localHour(yunaNight.next_attempt_at, 'Asia/Seoul'), 8);
  await notices.processQueue(new Date(new Date(yunaNight.next_attempt_at).getTime() + 60_000));
  assert.equal((await noticeOf(yuna)).status, 'sent');

  // 8. 끄면 새로 줄 세우지 않고, 남은 안내도 보내지 않는다.
  await put('/consent-notices/settings', { enabled: false });
  await post('/contacts/import', { contacts: [{ email: 'off@example.com', name: 'Off', lists: ['early access'], ...evidence, consent_at: consentFor(9) }] });
  assert.equal(await notices.plan(new Date()), 0);
  await noticeRepo.update({ contact_id: orphan.id }, { next_attempt_at: new Date(noon.getTime() - 1000) });
  await notices.processQueue(noon);
  assert.match((await noticeOf(orphan)).error, /turned off/);
});
