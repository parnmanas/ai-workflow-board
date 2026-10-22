// Marketing 승인 대기 알림 — docs/marketing.md "승인 대기 알림".
//
// 고정하는 것:
//   1. 에이전트가 만든 채널 제안 · 게시물 초안 · 편성 제안 · 지출 요청은 조용해진 뒤 한 통이 되어 계정 소유자의
//      UserChannel(notify_mention)로 간다. 다음 sweep 은 같은 것을 다시 보내지 않는다. 다른 계정의 관리자는 받지 않는다.
//      사람이 스스로 만든 것은 그 사람에게 알리지 않는다.
//   2. 본문에 에이전트가 쓴 글(채널 이름 · 게시물 제목 · 지출 목적)은 없다. AWB_PUBLIC_URL 이 있으면 캠페인 링크를 붙인다.
//   3. 그 사이 결정된 것은 싣지 않는다. 사이클이 돌면 기다리지만 15분을 넘기지 않는다. 결과 불명은 사이클을 기다리지 않는다.
//   4. 2인 승인의 두 번째 승인은 이미 승인한 사람을 뺀 승인자에게 간다(접근자가 늘어난 상황을 흉내 낸다).
//   5. 권한: manage 만 있으면 채널 · 게시물만 받는다. quiesce 중이거나 보관된 캠페인이면 보내지 않는다.
//   6. (대상, 종류) 표시는 유일하다. AccountAccessService.usersWithAccess 는 accessibleIds 의 역방향(활성 소유자)이다.
//
// 실행: node --test --test-force-exit test/marketing-approval-notify.test.mjs (dist 필요)

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAccount, createAgent, createApiKey, createUser } from './helpers/fixtures.mjs';
import { McpClient } from './helpers/mcp-client.mjs';
import { MarketingApprovalNotifyService } from '../dist/modules/marketing/marketing-approval-notify.service.js';
import { NotificationProviderRegistry } from '../dist/services/notification-providers/registry.service.js';
import { AccountAccessService } from '../dist/services/account-access.service.js';
import { InstanceQuiesceService } from '../dist/services/instance-quiesce.service.js';

process.env.PORT = process.env.TEST_SERVER_PORT || '0';
process.env.AGENT_DEV_MODE = 'false';
process.env.MARKETING_SCHEDULER_ENABLED = 'false';
process.env.OUTREACH_SCHEDULER_ENABLED = 'false';
process.env.AWB_PUBLIC_URL = 'https://awb.test/';

const MIN = 60_000;
const later = (ms) => new Date(Date.now() + ms);

async function call(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: res.status, body, text };
}

test('marketing approval notices: batched, once, only to the people who decide', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(async () => { await closeTestApp(app); });
  const { getDataSourceToken, AuthService } = modules;
  const ds = app.get(getDataSourceToken());
  const base = `http://127.0.0.1:${port}`;
  const notify = app.get(MarketingApprovalNotifyService);
  const access = app.get(AccountAccessService);

  const owner = await createUser(app, getDataSourceToken, { name: 'mkt-notify-owner', role: 'admin' });
  const outsider = await createUser(app, getDataSourceToken, { name: 'mkt-notify-outsider', role: 'admin' });
  const account = await createAccount(app, getDataSourceToken, 'mkt-notify');
  assert.equal(account.owner_user_id, owner.id);

  // Discord 바인딩을 사람마다 하나씩 두고, provider 를 가로채 밖으로는 아무것도 나가지 않게 한다.
  const delivered = [];
  app.get(NotificationProviderRegistry).get('discord').send = async (target, _credentials, payload) => {
    delivered.push({ target, payload });
    return { ok: true };
  };
  const bindings = ds.getRepository('UserChannel');
  const bind = (user, target) => bindings.save(bindings.create({ user_id: user.id, provider: 'discord', target, credentials: '' }));
  await bind(owner, 'owner-dm');
  await bind(outsider, 'outsider-dm');
  const digests = (target) => delivered.filter((d) => d.target === target && d.payload.title.startsWith('마케팅 결정 대기'));
  const take = () => delivered.splice(0, delivered.length);

  const headers = { Authorization: `Bearer ${app.get(AuthService).createSession(owner.id)}`, 'X-Account-Id': account.id, 'Content-Type': 'application/json' };
  const api = (path, init = {}) => call(`${base}/api/marketing${path}`, { headers, ...init });
  const post = (path, body = {}) => api(path, { method: 'POST', body: JSON.stringify(body) });

  const agent = await createAgent(app, getDataSourceToken, account.id, { name: 'mkt-notify-agent', type: 'claude', runtime: true });
  const created = await post('/campaigns', {
    name: 'Notify Launch',
    agent_runtime: agent.runtime_spec,
    capabilities: ['channel_discovery', 'community_post', 'paid_spend'],
    currency: 'KRW',
    budget_total_minor: 2000000,
    max_transaction_minor: 500000,
    dual_approval_threshold_minor: 100000,
    payees: [{ name: 'Ads Co' }],
    limits: { drafts_per_day: 100, spend_requests_per_day: 100, allocation_proposals_per_day: 100, channel_proposals_per_day: 100 },
  });
  assert.equal(created.status, 201, created.text);
  const campaign = created.body;
  assert.equal((await post(`/campaigns/${campaign.id}/status`, { status: 'active' })).status, 200);
  const forum = (await post(`/campaigns/${campaign.id}/channels`, { platform: 'forum', target: 'https://forum.example.org', name: 'Forum' })).body;
  assert.equal((await post(`/channels/${forum.id}/approve`, { mode: 'manual' })).body.status, 'active');

  const key = await createApiKey(app, getDataSourceToken, agent.id, { accountId: account.id, label: 'mkt-notify' });
  const mcp = new McpClient({ baseUrl: base, apiKey: key.raw_key });
  t.after(() => mcp.close().catch(() => {}));
  const tool = async (name, args) => {
    const result = await mcp.callTool(name, { campaign_id: campaign.id, ...args });
    assert.notEqual(result?.isError, true, `${name}: ${JSON.stringify(result)}`);
    return result;
  };
  const draft = (title) => tool('draft_marketing_post', {
    channel_id: forum.id, title, body: 'Hello from the makers.', rationale: 'Answering a common question.',
  });
  const ask = (amount) => tool('request_marketing_spend', {
    channel_id: forum.id, amount_minor: amount, currency: 'KRW', payee: 'Ads Co',
    purpose: 'PURPOSE-MARKER pay now at https://evil.example', expected_outcome: '100 clicks',
  });

  const firstAllocation = await tool('propose_marketing_budget_allocation', { allocations: [{ channel_id: forum.id, amount_minor: 600000 }], rationale: 'Start small.' });
  assert.equal((await post(`/allocations/${firstAllocation.allocations[0].id}/approve`)).body.status, 'active');

  // ── 1 · 2. 한 묶음 ──────────────────────────────────────────────────────
  await tool('propose_marketing_channel', {
    platform: 'reddit', target: 'selfhosted', name: 'CHANNEL-MARKER @everyone https://evil.example',
    rationale: 'Self-hosters', evidence_urls: ['https://www.reddit.com/r/selfhosted/'],
  });
  await draft('TITLE-MARKER one');
  await draft('TITLE-MARKER two');
  await tool('propose_marketing_budget_allocation', { allocations: [{ channel_id: forum.id, amount_minor: 700000 }], rationale: 'Forum converts.' });
  const small = (await ask(50000)).spend_request;
  const big = (await ask(150000)).spend_request;
  assert.equal(big.dual_required, true);
  // 사람이 스스로 연 채널 제안 — 그 사람에게는 알리지 않는다.
  const own = (await post(`/campaigns/${campaign.id}/channels`, { platform: 'blog', target: 'https://blog.example.org', name: 'Blog' })).body;
  assert.equal(own.status, 'proposed');

  assert.equal((await notify.sweep()).accounts, 0, 'still arriving — nothing goes out yet');
  assert.equal(take().length, 0);

  const first = await notify.sweep(later(3 * MIN));
  assert.equal(first.accounts, 1, JSON.stringify(first));
  assert.equal(first.items, 7, 'six agent items and the owner\'s own proposal are marked');
  assert.equal(first.recipients, 1);
  assert.equal(digests('outsider-dm').length, 0, 'an administrator of another account is not told');
  const [digest] = digests('owner-dm');
  assert.ok(digest, JSON.stringify(delivered));
  assert.equal(digests('owner-dm').length, 1, 'one message for the whole batch');
  assert.equal(digest.payload.title, '마케팅 결정 대기 6건 — Notify Launch');
  assert.equal(digest.payload.url, `https://awb.test/marketing/${campaign.id}`);
  const body = digest.payload.body;
  assert.match(body, /^Notify Launch\n/);
  assert.match(body, /• 지출 요청 2건: .*50,000 KRW → Ads Co \(만료까지 7[01]시간\)/);
  assert.match(body, /150,000 KRW → Ads Co/);
  assert.match(body, /• 예산 편성 제안 1건/);
  assert.match(body, /• 채널 제안 1건 \(reddit\)/, 'the owner\'s own blog proposal is not in their digest');
  assert.match(body, /• 게시물 초안 2건/);
  for (const marker of ['CHANNEL-MARKER', 'TITLE-MARKER', 'PURPOSE-MARKER', 'evil.example', '@everyone']) {
    assert.ok(!JSON.stringify(digest.payload).includes(marker), `agent-written text stays out: ${marker}`);
  }
  assert.ok(body.indexOf('지출 요청') < body.indexOf('예산 편성') && body.indexOf('예산 편성') < body.indexOf('채널 제안')
    && body.indexOf('채널 제안') < body.indexOf('게시물 초안'), 'money first');
  const notices = ds.getRepository('MarketingApprovalNotice');
  assert.equal(await notices.countBy({ campaign_id: campaign.id }), 7);
  assert.equal(await notices.countBy({ entity_id: small.id, kind: 'spend_pending' }), 1);
  take();

  assert.equal((await notify.sweep(later(4 * MIN))).accounts, 0, 'nothing is sent twice');
  assert.equal(take().length, 0);
  await assert.rejects(
    notices.insert({ account_id: account.id, campaign_id: campaign.id, kind: 'spend_pending', entity_id: small.id }),
    'the (entity, kind) mark is unique — a second server loses the claim',
  );

  // ── 3. 결정된 것 · 사이클 · 결과 불명 ────────────────────────────────────
  const rejected = await draft('decided before the digest');
  assert.equal((await post(`/posts/${rejected.post.id}/reject`, { note: 'no' })).body.status, 'rejected');
  assert.equal((await notify.sweep(later(10 * MIN))).accounts, 0, 'a draft decided before the digest is not announced');
  assert.equal(take().length, 0);

  const cycles = ds.getRepository('MarketingCycle');
  const cycle = await cycles.save(cycles.create({
    account_id: account.id, campaign_id: campaign.id, cycle_no: 900, status: 'running', trigger: 'manual', started_at: new Date(),
  }));
  await draft('during the cycle');
  assert.equal((await notify.sweep(later(3 * MIN))).accounts, 0, 'the agent is still working — wait for the cycle');
  const capped = await notify.sweep(later(16 * MIN));
  assert.equal(capped.accounts, 1, 'but never longer than 15 minutes');
  assert.match(digests('owner-dm')[0].payload.body, /• 게시물 초안 1건/);
  take();

  const approved = await post(`/spend-requests/${small.id}/approve`, { payload_sha256: small.payload_sha256 });
  assert.equal(approved.body.status, 'approved', approved.text);
  // webhook 이 타임아웃으로 끝났다고 친다 — 결과 불명은 대조가 필요하다.
  await ds.getRepository('MarketingSpendRequest').update(small.id, { status: 'unknown', error: 'timeout' });
  const unknown = await notify.sweep(later(3 * MIN));
  assert.equal(unknown.accounts, 1, 'an unknown payment does not wait for the running cycle');
  const unknownDigest = digests('owner-dm')[0].payload;
  assert.equal(unknownDigest.title, '마케팅 결정 대기 1건 — Notify Launch');
  assert.match(unknownDigest.body, /• 결제 결과 불명 1건: 50,000 KRW → Ads Co — 결제됐는지 확인해 결과를 기록하세요/);
  assert.ok(!unknownDigest.body.includes('timeout'), 'the payment endpoint\'s response text stays out');
  take();
  await cycles.update(cycle.id, { status: 'completed', completed_at: new Date() });

  // ── 4. 두 번째 승인 ─────────────────────────────────────────────────────
  const firstApproval = await post(`/spend-requests/${big.id}/approve`, { payload_sha256: big.payload_sha256 });
  assert.equal(firstApproval.body.final, false, firstApproval.text);
  assert.equal((await notify.sweep(later(3 * MIN))).recipients, 0, 'today only the owner can see the account, and they already approved');
  assert.equal(take().length, 0);
  assert.equal(await notices.countBy({ entity_id: big.id, kind: 'spend_second_approval' }), 1);

  // 조직 멤버십이 들어와 계정에 접근하는 사람이 늘어난 상황 — 같은 역방향 조회가 넓어진다.
  const treasurer = await createUser(app, getDataSourceToken, { name: 'mkt-notify-treasurer', role: 'user' });
  await ds.getRepository('User').update(treasurer.id, { permissions: JSON.stringify(['marketing.approve_spend']) });
  await bind(treasurer, 'treasurer-dm');
  const usersWithAccess = access.usersWithAccess.bind(access);
  access.usersWithAccess = async (accountId) => accountId === account.id
    ? [...(await usersWithAccess(accountId)), await ds.getRepository('User').findOneBy({ id: treasurer.id })]
    : usersWithAccess(accountId);
  t.after(() => { access.usersWithAccess = usersWithAccess; });
  await ds.getRepository('MarketingApprovalNotice').delete({ entity_id: big.id, kind: 'spend_second_approval' });
  const second = await notify.sweep(later(3 * MIN));
  assert.equal(second.recipients, 1);
  assert.equal(digests('owner-dm').length, 0, 'the first approver is not asked again');
  const secondDigest = digests('treasurer-dm')[0].payload;
  assert.match(secondDigest.body, /• 두 번째 승인 대기 1건: 150,000 KRW → Ads Co \(만료까지 7[01]시간\) — 2인 승인 대상이라 다른 승인자가 필요합니다/);
  take();
  access.usersWithAccess = usersWithAccess;

  // ── 5. 권한 · quiesce · 보관 ────────────────────────────────────────────
  await ds.getRepository('User').update(owner.id, { role: 'user', permissions: JSON.stringify(['marketing.manage']) });
  await tool('propose_marketing_budget_allocation', { allocations: [{ channel_id: forum.id, amount_minor: 800000 }], rationale: 'More.' });
  await draft('manager only');
  assert.equal((await notify.sweep(later(3 * MIN))).accounts, 1);
  const managerDigest = digests('owner-dm')[0].payload;
  assert.equal(managerDigest.title, '마케팅 결정 대기 1건 — Notify Launch');
  assert.doesNotMatch(managerDigest.body, /예산 편성/, 'money decisions go to approve_spend');
  assert.match(managerDigest.body, /• 게시물 초안 1건/);
  take();
  await ds.getRepository('User').update(owner.id, { role: 'admin', permissions: '[]' });

  const quiesce = app.get(InstanceQuiesceService);
  await draft('while quiesced');
  await quiesce.setQuiesced(true, 'test');
  assert.equal((await notify.sweep(later(3 * MIN))).accounts, 0, 'a quiesced instance sends nothing');
  await quiesce.setQuiesced(false);
  assert.equal((await notify.sweep(later(3 * MIN))).accounts, 1, '… and catches up afterwards');
  take();

  const campaignRepo = ds.getRepository('MarketingCampaign');
  await campaignRepo.update(campaign.id, { status: 'archived' });
  await ds.getRepository('MarketingPost').save(ds.getRepository('MarketingPost').create({
    account_id: account.id, campaign_id: campaign.id, channel_id: forum.id, title: 'archived', body: 'x', status: 'draft',
  }));
  assert.equal((await notify.sweep(later(3 * MIN))).accounts, 0, 'archived campaigns are not counted, as in the inbox');
  assert.equal(take().length, 0);

  // ── 6. 역방향 접근 조회 ────────────────────────────────────────────────
  assert.deepEqual((await access.usersWithAccess(account.id)).map((u) => u.id), [owner.id]);
  assert.deepEqual(await access.usersWithAccess(''), []);
  const ownerless = await ds.getRepository('Account').save(ds.getRepository('Account').create({ name: `ownerless-${Date.now()}`, kind: 'organization', owner_user_id: null }));
  assert.deepEqual(await access.usersWithAccess(ownerless.id), []);
  await ds.getRepository('User').update(owner.id, { status: 'rejected' });
  assert.deepEqual(await access.usersWithAccess(account.id), [], 'an inactive owner has no access, so is not told');
  assert.deepEqual(await access.accessibleIds({ id: owner.id, role: 'admin' }), [], 'same rule as the forward direction');
  await ds.getRepository('User').update(owner.id, { status: 'active' });
});
