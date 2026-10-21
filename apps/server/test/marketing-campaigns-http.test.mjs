// Marketing 캠페인 REST · MCP 배선 — docs/marketing.md.
//
// 고정하는 것:
//   1. marketing.manage 는 기본 admin 전용이다. 부여받은 일반 사용자는 자기 계정의 캠페인만 다룬다 —
//      다른 계정 캠페인의 상세 · 수정은 실제 소유 계정으로 검사돼 403 이다.
//   2. 생성 · 수정 입력 검증(이름 · 통화 · 금액 · 도메인 · 같은 계정 project), project 를 고르면 그 계정 소유.
//   3. 상태 전이: agent_runtime 없이 활성화 불가(409), 활성화하면 다음 사이클 시각이 잡히고 일시정지하면 지워진다.
//   4. 모든 변경이 감사 로그에 남는다(이전/이후 값). SSE `marketing_update` 가 계정 사용자에게 간다.
//   5. MCP list/get_marketing_campaign 은 DB-backed 키의 소유 계정만 보고, 다른 계정 키는 거부된다.
//
// 실행: node --test --test-force-exit test/marketing-campaigns-http.test.mjs (dist 필요)

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAccount, createAgent, createApiKey, createProject, createUser } from './helpers/fixtures.mjs';
import { McpClient } from './helpers/mcp-client.mjs';
import { openSseStream } from './helpers/sse-listener.mjs';
import { ReBACService } from '../dist/services/rebac.service.js';

process.env.PORT = process.env.TEST_SERVER_PORT || '0';
process.env.AGENT_DEV_MODE = 'false';

async function call(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: res.status, body, text };
}

test('marketing campaigns: permissions, validation, lifecycle, audit, SSE and MCP scope', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(async () => { await closeTestApp(app); });
  const { getDataSourceToken, AuthService } = modules;
  const ds = app.get(getDataSourceToken());
  const base = `http://127.0.0.1:${port}`;

  const mine = await createAccount(app, getDataSourceToken, 'mkt-mine');
  const theirs = await createAccount(app, getDataSourceToken, 'mkt-theirs');
  const admin = await createUser(app, getDataSourceToken, { name: 'mkt-admin', role: 'admin' });
  const marketer = await createUser(app, getDataSourceToken, { name: 'mkt-marketer', role: 'user' });
  const plain = await createUser(app, getDataSourceToken, { name: 'mkt-plain', role: 'user' });
  await ds.getRepository('User').update(marketer.id, { permissions: JSON.stringify(['marketing.manage']) });
  const rebac = app.get(ReBACService);
  await rebac.grant({ type: 'user', id: marketer.id }, 'member', { type: 'account', id: mine.id });
  await rebac.grant({ type: 'user', id: plain.id }, 'member', { type: 'account', id: mine.id });

  const auth = (user, accountId) => ({
    Authorization: `Bearer ${app.get(AuthService).createSession(user.id)}`,
    'Content-Type': 'application/json',
    ...(accountId ? { 'X-Account-Id': accountId } : {}),
  });
  const adminH = auth(admin, mine.id);
  const marketerH = auth(marketer, mine.id);
  const api = (path, headers, init = {}) => call(`${base}/api/marketing${path}`, { headers, ...init });
  const post = (path, headers, body) => api(path, headers, { method: 'POST', body: JSON.stringify(body) });
  const patch = (path, headers, body) => api(path, headers, { method: 'PATCH', body: JSON.stringify(body) });

  // 1. 권한
  assert.equal((await api('/campaigns', auth(plain, mine.id))).status, 403, 'marketing.manage is admin-only by default');

  // 2. 생성 + 검증
  assert.equal((await post('/campaigns', marketerH, {})).status, 400, 'name is required');
  assert.equal((await post('/campaigns', marketerH, { name: 'x', currency: 'kr' })).status, 400);
  assert.equal((await post('/campaigns', marketerH, { name: 'x', budget_total_minor: 12.5 })).status, 400, 'floats are rejected');
  assert.equal((await post('/campaigns', marketerH, { name: 'x', allowed_domains: ['localhost'] })).status, 400);
  assert.equal((await post('/campaigns', marketerH, { name: 'x', capabilities: ['ads'] })).status, 400);

  const product = await createProject(app, getDataSourceToken, mine.id, { name: 'product' });
  const foreignProject = await createProject(app, getDataSourceToken, theirs.id, { name: 'foreign' });
  assert.equal((await post('/campaigns', marketerH, { name: 'x', project_id: foreignProject.id })).status, 403,
    'choosing another account\'s project makes that account the owner — which this user cannot reach');

  const sse = await openSseStream(port, marketerH.Authorization.slice('Bearer '.length));
  t.after(() => sse.close());

  const created = await post('/campaigns', marketerH, {
    name: 'Launch week',
    project_id: product.id,
    product_brief: 'AWB — agents that run your tickets.',
    capabilities: ['community_post', 'analytics', 'paid_spend'],
    currency: 'usd',
    budget_total_minor: '500000',
    budget_period: 'month',
    budget_period_minor: 200000,
    max_transaction_minor: 50000,
    payees: [{ name: 'Reddit Ads', ref: 'ads-acct-1' }],
    allowed_domains: ['https://awb.example.com/'],
    cycle_interval_ms: 3_600_000,
  });
  assert.equal(created.status, 201, created.text);
  const campaign = created.body;
  assert.equal(campaign.account_id, mine.id, 'owned by the project\'s account');
  assert.equal(campaign.status, 'draft');
  assert.equal(campaign.currency, 'USD');
  assert.equal(campaign.budget_total_minor, 500000);
  assert.deepEqual(campaign.allowed_domains, ['awb.example.com']);
  assert.match(campaign.slug, /^launch-week-[0-9a-f]{4}$/);
  assert.ok(campaign.disclosure.length > 0, 'a default disclosure is always present');
  assert.equal(campaign.next_cycle_at, null, 'drafts are not scheduled');

  const frame = await sse.waitFor('marketing_update', (data) => {
    const d = typeof data === 'string' ? JSON.parse(data) : data;
    return d?.campaign_id === campaign.id && d?.action === 'created';
  }, 5000);
  assert.ok(frame, 'marketing_update reaches users of the owning account');

  // 다른 계정의 캠페인(관리자가 만든 것)은 이 사용자에게 보이지 않는다.
  const foreign = await post('/campaigns', auth(admin, theirs.id), { name: 'Theirs' });
  assert.equal(foreign.status, 201, foreign.text);
  assert.equal(foreign.body.account_id, theirs.id);
  const listed = await api('/campaigns', marketerH);
  assert.equal(listed.status, 200, listed.text);
  assert.deepEqual(listed.body.map((c) => c.id), [campaign.id]);
  assert.equal((await api(`/campaigns/${foreign.body.id}`, marketerH)).status, 403, 'detail is checked against the real owner');
  assert.equal((await patch(`/campaigns/${foreign.body.id}`, marketerH, { name: 'mine now' })).status, 403);

  // 3. 상태 전이
  const noAgent = await post(`/campaigns/${campaign.id}/status`, marketerH, { status: 'active' });
  assert.equal(noAgent.status, 409, 'an agent is required before activation');
  const agent = await createAgent(app, getDataSourceToken, mine.id, { name: 'marketer-agent', type: 'claude', runtime: true });
  const withAgent = await patch(`/campaigns/${campaign.id}`, marketerH, { agent_runtime: agent.runtime_spec, goal: 'Get 100 signups' });
  assert.equal(withAgent.status, 200, withAgent.text);
  assert.match(withAgent.body.agent_key, /^rt-[0-9a-f]{16}$/);
  const active = await post(`/campaigns/${campaign.id}/status`, marketerH, { status: 'active' });
  assert.equal(active.status, 200, active.text);
  assert.ok(active.body.next_cycle_at, 'activation schedules the next cycle');
  const nextAt = new Date(active.body.next_cycle_at).getTime();
  assert.ok(nextAt > Date.now() + 3_500_000 && nextAt < Date.now() + 3_700_000, 'interval cadence counts from activation');
  assert.equal((await patch(`/campaigns/${campaign.id}`, marketerH, { agent_runtime: null })).status, 400,
    'an active campaign cannot lose its agent');
  const paused = await post(`/campaigns/${campaign.id}/status`, marketerH, { status: 'paused' });
  assert.equal(paused.body.next_cycle_at, null);
  assert.equal((await post(`/campaigns/${campaign.id}/status`, marketerH, { status: 'draft' })).status, 409);

  // 4. 감사 로그
  const audit = await api(`/campaigns/${campaign.id}/audit`, marketerH);
  assert.equal(audit.status, 200, audit.text);
  const actions = audit.body.map((e) => e.action);
  for (const action of ['campaign.created', 'campaign.updated', 'campaign.active', 'campaign.paused']) {
    assert.ok(actions.includes(action), `audit has ${action}: ${actions.join(',')}`);
  }
  const update = audit.body.find((e) => e.action === 'campaign.updated' && e.detail.changes?.agent_key);
  assert.ok(update, 'agent change is recorded with before/after');
  assert.equal(update.actor_type, 'user');
  assert.equal(update.actor_id, marketer.id);
  assert.ok(update.detail.text_changed.includes('goal'), 'long text records only that it changed');

  // 5. MCP
  const key = await createApiKey(app, getDataSourceToken, agent.id, { accountId: mine.id, label: 'mkt' });
  const client = new McpClient({ baseUrl: base, apiKey: key.raw_key });
  t.after(() => client.close().catch(() => {}));
  const mcpList = await client.callTool('list_marketing_campaigns', {});
  assert.ok(Array.isArray(mcpList), JSON.stringify(mcpList));
  assert.deepEqual(mcpList.map((c) => c.id), [campaign.id], 'only the key\'s own account');
  const overview = await client.callTool('get_marketing_campaign', { campaign_id: campaign.id });
  assert.equal(overview.campaign.id, campaign.id);
  assert.ok(overview.rules.length >= 3);
  const deniedForeign = await client.callTool('get_marketing_campaign', { campaign_id: foreign.body.id });
  assert.equal(deniedForeign.isError, true);
  const deniedList = await client.callTool('list_marketing_campaigns', { account_id: theirs.id });
  assert.equal(deniedList.isError, true);

  // 삭제: 돈이 오간 적 없는 캠페인은 지울 수 있고, 감사 로그는 남는다.
  const removed = await api(`/campaigns/${campaign.id}`, marketerH, { method: 'DELETE' });
  assert.equal(removed.status, 200, removed.text);
  assert.equal((await api(`/campaigns/${campaign.id}`, marketerH)).status, 404);
  const kept = await ds.getRepository('MarketingAuditEvent').find({ where: { campaign_id: campaign.id } });
  assert.ok(kept.some((e) => e.action === 'campaign.deleted'), 'audit survives deletion');
});
