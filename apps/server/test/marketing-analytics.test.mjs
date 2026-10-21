// Marketing 분석 — docs/marketing.md "분석".
//
// 고정하는 것:
//   1. 추적 링크: AWB_PUBLIC_URL 이 없으면 만들지 않는다, 목적지는 캠페인 allowed_domains 안만, UTM 이 붙는다(기존 utm_* 는 보존).
//   2. 공개 GET /api/m/:code 는 저장된 주소로만 302. 모르는 코드 · 형식이 틀린 코드는 같은 404.
//      HEAD · 봇 UA · prefetch · 같은 클라이언트의 30 분 내 반복은 세지 않는다(이동은 시킨다). 같은 시간의 클릭은 한 지표 행에 모인다.
//   3. 지표 기록: analytics capability, 알려진 지표만(clicks 는 링크만), 음수 · 미래 · 다른 캠페인 채널 거부, 출처가 남는다.
//   4. 리포트: 채널별 클릭 · 지표 · 지출(원장 capture − refund) · CPC · 가입당 비용 · CTR 과 요약 줄 · raw 클릭 경고.
//
// 실행: node --test --test-force-exit test/marketing-analytics.test.mjs (dist 필요)

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAccount, createAgent, createApiKey, createUser } from './helpers/fixtures.mjs';
import { McpClient } from './helpers/mcp-client.mjs';
import { withUtm, hourStart } from '../dist/modules/marketing/marketing-analytics.service.js';

process.env.PORT = process.env.TEST_SERVER_PORT || '0';
process.env.AGENT_DEV_MODE = 'false';
process.env.MARKETING_SCHEDULER_ENABLED = 'false';
process.env.OUTREACH_SCHEDULER_ENABLED = 'false';
delete process.env.AWB_PUBLIC_URL;

const BROWSER = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

async function call(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: res.status, body, text, headers: res.headers };
}

test('utm helper keeps existing utm values', () => {
  const url = withUtm('https://awb.example.com/pricing?utm_source=newsletter&ref=x', { utm_source: 'reddit', utm_medium: 'community' });
  const u = new URL(url);
  assert.equal(u.searchParams.get('utm_source'), 'newsletter');
  assert.equal(u.searchParams.get('utm_medium'), 'community');
  assert.equal(u.searchParams.get('ref'), 'x');
  assert.equal(hourStart(new Date('2026-10-22T10:59:59.999Z')).toISOString(), '2026-10-22T10:00:00.000Z');
});

test('marketing analytics: tracked links, raw click counting, metrics and the per-channel report', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(async () => { await closeTestApp(app); delete process.env.AWB_PUBLIC_URL; });
  const { getDataSourceToken, AuthService } = modules;
  const ds = app.get(getDataSourceToken());
  const base = `http://127.0.0.1:${port}`;

  const account = await createAccount(app, getDataSourceToken, 'mkt-an');
  const admin = await createUser(app, getDataSourceToken, { name: 'mkt-an-admin', role: 'admin' });
  const H = { Authorization: `Bearer ${app.get(AuthService).createSession(admin.id)}`, 'X-Account-Id': account.id, 'Content-Type': 'application/json' };
  const api = (path, init = {}) => call(`${base}/api/marketing${path}`, { headers: H, ...init });
  const post = (path, body = {}) => api(path, { method: 'POST', body: JSON.stringify(body) });

  const agent = await createAgent(app, getDataSourceToken, account.id, { name: 'mkt-an-agent', type: 'claude', runtime: true });
  const campaign = (await post('/campaigns', {
    name: 'Analytics', agent_runtime: agent.runtime_spec, capabilities: ['community_post'],
    allowed_domains: ['awb.example.com'], currency: 'USD',
  })).body;
  await post(`/campaigns/${campaign.id}/status`, { status: 'active' });
  const forum = (await post(`/campaigns/${campaign.id}/channels`, { platform: 'forum', target: 'https://forum.example.org/c/tools' })).body;
  await post(`/channels/${forum.id}/approve`, { mode: 'manual' });
  const blog = (await post(`/campaigns/${campaign.id}/channels`, { platform: 'blog', target: 'https://devblog.example.net' })).body;
  await post(`/channels/${blog.id}/approve`, { mode: 'manual' });

  const key = await createApiKey(app, getDataSourceToken, agent.id, { accountId: account.id, label: 'mkt-an' });
  const mcp = new McpClient({ baseUrl: base, apiKey: key.raw_key });
  t.after(() => mcp.close().catch(() => {}));
  const errText = (r) => (typeof r?.error === 'string' ? r.error : r?.error?.error || JSON.stringify(r));
  const link = (fields) => mcp.callTool('create_marketing_link', { campaign_id: campaign.id, channel_id: forum.id, ...fields });

  // 1. 링크
  assert.match(errText(await link({ destination_url: 'https://awb.example.com/' })), /capability "analytics"/);
  await api(`/campaigns/${campaign.id}`, { method: 'PATCH', body: JSON.stringify({ capabilities: ['community_post', 'analytics'] }) });
  assert.match(errText(await link({ destination_url: 'https://awb.example.com/' })), /AWB_PUBLIC_URL/);
  process.env.AWB_PUBLIC_URL = `${base}/`;
  assert.match(errText(await link({ destination_url: 'https://evil.example.com/' })), /allowed_domains/);
  assert.match(errText(await link({ destination_url: 'javascript:alert(1)' })), /http/);
  const made = await link({ destination_url: 'https://docs.awb.example.com/start?utm_source=keep', label: 'docs' });
  assert.ok(made.link, JSON.stringify(made));
  assert.match(made.link.code, /^[A-Za-z0-9]{12}$/);
  assert.equal(made.link.url, `${base}/api/m/${made.link.code}`);
  const redirect = new URL(made.link.redirect_url);
  assert.equal(redirect.searchParams.get('utm_source'), 'keep');
  assert.equal(redirect.searchParams.get('utm_medium'), 'community');
  assert.equal(redirect.searchParams.get('utm_campaign'), campaign.slug);

  // 2. 공개 리다이렉트 · 세기
  const go = (headers = {}, method = 'GET', code = made.link.code) => fetch(`${base}/api/m/${code}`, { method, redirect: 'manual', headers: { 'user-agent': BROWSER, ...headers } });
  const first = await go({ 'x-forwarded-for': '203.0.113.1' });
  assert.equal(first.status, 302);
  assert.equal(first.headers.get('location'), made.link.redirect_url);
  await go({ 'x-forwarded-for': '203.0.113.1' });
  await go({ 'x-forwarded-for': '203.0.113.2' });
  await go({ 'x-forwarded-for': '203.0.113.3', 'user-agent': 'Twitterbot/1.0' });
  await go({ 'x-forwarded-for': '203.0.113.4', 'sec-purpose': 'prefetch' });
  const head = await go({ 'x-forwarded-for': '203.0.113.5' }, 'HEAD');
  assert.equal(head.status, 302, 'HEAD still redirects');
  const unknown = await go({}, 'GET', 'ZZZZZZZZZZZZ');
  const malformed = await go({}, 'GET', 'abc');
  assert.equal(unknown.status, 404);
  assert.equal(malformed.status, 404);
  assert.equal(await unknown.text(), await malformed.text(), 'unknown and malformed codes look the same');
  const links = (await api(`/campaigns/${campaign.id}/links`)).body;
  assert.equal(links.length, 1, 'a refused link (no public URL, bad domain) leaves no row behind');
  assert.equal(links[0].clicks, 2, 'repeat, bot, prefetch and HEAD are not counted');
  const clickRows = await ds.getRepository('MarketingMetric').find({ where: { link_id: made.link.id, metric: 'clicks' } });
  assert.equal(clickRows.length, 1, 'one row per hour bucket');
  assert.equal(clickRows[0].value, 2);

  // 3. 지표
  const rec = (observations) => mcp.callTool('record_marketing_metrics', { campaign_id: campaign.id, observations });
  assert.ok((await rec([{ metric: 'clicks', value: 5, channel_id: forum.id }])).isError, 'clicks come only from links');
  assert.match(errText(await rec([{ metric: 'impressions', value: 1, channel_id: forum.id, observed_at: '2999-01-01T00:00:00Z' }])), /future/);
  assert.match(errText(await rec([{ metric: 'impressions', value: 1, channel_id: '00000000-0000-4000-8000-000000000000' }])), /channel not found/);
  const recorded = await rec([
    { metric: 'impressions', value: 1000, channel_id: forum.id, note: 'forum stats page' },
    { metric: 'signups', value: 10, channel_id: forum.id },
    { metric: 'followers', value: 300, channel_id: blog.id, observed_at: new Date(Date.now() - 60_000).toISOString() },
    { metric: 'followers', value: 320, channel_id: blog.id },
  ]);
  assert.equal(recorded.recorded.length, 4, JSON.stringify(recorded));
  assert.equal(recorded.recorded[0].source, 'agent');

  // 4. 리포트 — 지출은 원장에서
  await ds.getRepository('MarketingLedgerEntry').save([
    { account_id: account.id, campaign_id: campaign.id, channel_id: forum.id, spend_request_id: 'r1', kind: 'capture', amount_minor: 6000, currency: 'USD', period_key: 'all', actor_type: 'user' },
    { account_id: account.id, campaign_id: campaign.id, channel_id: forum.id, spend_request_id: 'r1', kind: 'refund', amount_minor: 1000, currency: 'USD', period_key: 'all', actor_type: 'user' },
  ].map((r) => ds.getRepository('MarketingLedgerEntry').create(r)));
  const report = await mcp.callTool('get_marketing_report', { campaign_id: campaign.id });
  const forumRow = report.channels.find((c) => c.channel_id === forum.id);
  assert.equal(forumRow.metrics.clicks, 2);
  assert.equal(forumRow.metrics.impressions, 1000);
  assert.equal(forumRow.spent_minor, 5000);
  assert.equal(forumRow.derived.cpc_minor, 2500);
  assert.equal(forumRow.derived.cost_per_signup_minor, 500);
  assert.equal(forumRow.derived.ctr, 0.002);
  const blogRow = report.channels.find((c) => c.channel_id === blog.id);
  assert.equal(blogRow.metrics.followers, 320, 'gauges use the latest observation');
  assert.equal(report.totals.spent_minor, 5000);
  assert.ok(report.lines.some((l) => l.includes('CPC 25.00 USD')), report.lines.join('\n'));
  assert.ok(report.caveats.some((c) => /raw/.test(c)));
  const rest = await api(`/campaigns/${campaign.id}/report?since=${encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString())}`);
  assert.equal(rest.status, 200, rest.text);
  assert.equal(rest.body.channels.length, 2);
});
