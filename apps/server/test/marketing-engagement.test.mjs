// Marketing 참여 지표 자동 수집 — docs/marketing.md "참여 지표 자동 수집".
//
// 고정하는 것:
//   1. outreach 게시가 1 시간 뒤 첫 읽기를 잡는다(manual 게시는 잡지 않는다). 그 전에는 읽지 않는다.
//   2. 읽을 때마다 변화량만 MarketingMetric(source connector)에 남는다(음수 포함, 변화 없으면 없음). 행의 합 = 게시물의
//      마지막 값. 리포트(누적형 합)는 기간의 증가분을 보이고, 게시물 JSON · 에이전트 개요에 마지막 값이 실린다.
//   3. 나이별 간격, 14 일째 마지막 읽기 뒤 끝. 플랫폼이 돌려주지 않은 글은 실패로 남고 같은 간격으로 다시 읽는다.
//   4. rate limit: 채널 cap 의 절반은 남긴다(몫이 없으면 미룬다). reddit 은 한 요청에 여러 글. 채널 전체 오류면 그 채널은 미룬다.
//   5. claim: 읽는 사이 다른 서버가 맡으면(rev 가 바뀌면) 값도 행도 남기지 않고, lease 뒤에 다시 읽는다.
//   6. 보관된 캠페인은 멈추고 다시 잡히지 않는다. 일시정지된 캠페인은 계속 읽는다. 기능 전 게시물도 기간 안이면 잡힌다.
//   7. 이중 집계 방지: 서버가 읽는 채널(과 그 게시물)의 engagements · replies 는 사람 · 에이전트가 기록하지 못한다.
//
// 실행: node --test --test-force-exit test/marketing-engagement.test.mjs (dist 필요)

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAccount, createAgent, createApiKey, createUser } from './helpers/fixtures.mjs';
import { McpClient } from './helpers/mcp-client.mjs';
import { encrypt } from '../dist/services/encryption.service.js';
import { MarketingPostService } from '../dist/modules/marketing/marketing-post.service.js';
import { MarketingEngagementService } from '../dist/modules/marketing/marketing-engagement.service.js';
import { FakeOutreachConnector } from '../dist/modules/outreach/connectors/fake.connector.js';
import { OutreachRateLimiter, OutreachChannelRateLimitedError } from '../dist/modules/outreach/outreach-rate-limiter.js';

process.env.PORT = process.env.TEST_SERVER_PORT || '0';
process.env.AGENT_DEV_MODE = 'false';
process.env.MARKETING_SCHEDULER_ENABLED = 'false';
process.env.OUTREACH_SCHEDULER_ENABLED = 'false';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

async function call(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: res.status, body, text };
}

test('marketing engagement collection: schedule, deltas, report, rate budget, claims, stops', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(async () => { await closeTestApp(app); });
  const { getDataSourceToken, AuthService } = modules;
  const ds = app.get(getDataSourceToken());
  const base = `http://127.0.0.1:${port}`;
  const postRepo = ds.getRepository('MarketingPost');
  const metricRepo = ds.getRepository('MarketingMetric');

  // 채널(OutreachChannel)마다 가짜 커넥터 하나 — 게시도 읽기도 그것으로.
  const fakes = new Map();
  const fakeFor = (outreach) => {
    if (!fakes.has(outreach.id)) fakes.set(outreach.id, new FakeOutreachConnector());
    return fakes.get(outreach.id);
  };
  app.get(MarketingPostService).connectorFactory = async (outreach) => fakeFor(outreach);
  const collector = app.get(MarketingEngagementService);
  let override = null;
  collector.connectorFactory = async (outreach) => (override ? override(outreach) : fakeFor(outreach));
  collector.rateLimiter = new OutreachRateLimiter();

  const account = await createAccount(app, getDataSourceToken, 'mkt-eng');
  const admin = await createUser(app, getDataSourceToken, { name: 'mkt-eng-admin', role: 'admin' });
  const H = { Authorization: `Bearer ${app.get(AuthService).createSession(admin.id)}`, 'X-Account-Id': account.id, 'Content-Type': 'application/json' };
  const api = (path, init = {}) => call(`${base}/api/marketing${path}`, { headers: H, ...init });
  const post = (path, body = {}) => api(path, { method: 'POST', body: JSON.stringify(body) });

  const agent = await createAgent(app, getDataSourceToken, account.id, { name: 'mkt-eng-agent', type: 'claude', runtime: true });
  const makeCampaign = async (name) => {
    const c = (await post('/campaigns', { name, agent_runtime: agent.runtime_spec, capabilities: ['community_post', 'analytics'], currency: 'USD' })).body;
    assert.equal((await post(`/campaigns/${c.id}/status`, { status: 'active' })).status, 200);
    return c;
  };
  const campaign = await makeCampaign('Engagement');
  const cred = await ds.getRepository('Credential').save(ds.getRepository('Credential').create({
    account_id: account.id, name: 'bot', description: '', provider: 'custom',
    encrypted_data: encrypt(JSON.stringify({ username: 'bot', token: 'x', client_id: 'c', client_secret: 's' })),
  }));
  const outreachChannel = async (c, platform, target) => {
    const ch = (await post(`/campaigns/${c.id}/channels`, { platform, target })).body;
    const approved = (await post(`/channels/${ch.id}/approve`, { mode: 'outreach', create_outreach: { credential_id: cred.id } })).body;
    assert.equal(approved.status, 'active', JSON.stringify(approved));
    return approved;
  };
  const reddit = await outreachChannel(campaign, 'reddit', 'selfhosted');
  const github = await outreachChannel(campaign, 'github', 'acme/widget');
  const forum = (await post(`/campaigns/${campaign.id}/channels`, { platform: 'forum', target: 'https://forum.example.org/c/tools' })).body;
  await post(`/channels/${forum.id}/approve`, { mode: 'manual' });
  const redditFake = fakeFor({ id: reddit.outreach_channel_id });
  const githubFake = fakeFor({ id: github.outreach_channel_id });
  githubFake.engagementRefsPerRequest = 1;

  const key = await createApiKey(app, getDataSourceToken, agent.id, { accountId: account.id, label: 'mkt-eng' });
  const mcp = new McpClient({ baseUrl: base, apiKey: key.raw_key });
  t.after(() => mcp.close().catch(() => {}));
  const errText = (r) => (typeof r?.error === 'string' ? r.error : r?.error?.error || JSON.stringify(r));

  let n = 0;
  const publish = async (channel, fields = {}) => {
    n++;
    const drafted = await mcp.callTool('draft_marketing_post', {
      campaign_id: fields.campaign_id || campaign.id, channel_id: channel.id, title: `Post ${n}`, body: `Body ${n}`, rationale: 'Engagement test.', ...fields,
    });
    assert.ok(drafted.post, JSON.stringify(drafted));
    const approved = await post(`/posts/${drafted.post.id}/approve`, {});
    assert.equal(approved.status, 200, approved.text);
    return approved.body;
  };
  const row = (id) => postRepo.findOne({ where: { id } });
  // 시각을 돌린다: 게시 시각을 과거로 옮기고 그 기준으로 sweep 한다(지표 행이 기본 30 일 리포트 안에 들어오게).
  const T0 = Date.now() - 15 * DAY;
  const at = (ms) => new Date(T0 + ms);
  const backdate = (id, nextMs = HOUR) => postRepo.update(id, { published_at: at(0), engagement_next_at: at(nextMs) });
  const connectorRows = async (postId, metric) => metricRepo.find({ where: { post_id: postId, metric, source: 'connector' }, order: { bucket_start: 'ASC' } });
  const sum = (rows) => rows.reduce((a, r) => a + Number(r.value), 0);

  // 1. 게시가 첫 읽기를 잡는다 — manual 은 잡지 않는다.
  const p1 = await publish(reddit);
  assert.equal(p1.status, 'published');
  assert.equal(p1.engagement, null);
  assert.equal(p1.engagement_error, '');
  assert.equal(new Date(p1.engagement_next_at).getTime() - new Date(p1.published_at).getTime(), HOUR, 'first read an hour after publishing');
  const manualDraft = await mcp.callTool('draft_marketing_post', { campaign_id: campaign.id, channel_id: forum.id, body: 'Forum text', rationale: 'x' });
  await post(`/posts/${manualDraft.post.id}/approve`, {});
  const manual = (await post(`/posts/${manualDraft.post.id}/mark-published`, { permalink: 'https://forum.example.org/t/1' })).body;
  assert.equal(manual.status, 'published');
  assert.equal(manual.engagement_next_at, null, 'a person posts manual channels — nothing for the server to read');

  await backdate(p1.id);
  assert.deepEqual(await collector.sweep(at(30 * MIN)), { read: 0, changed: 0, failed: 0, stopped: 0, deferred: 0 }, 'not due yet');

  // 2. 변화량만 남는다.
  redditFake.engagement.set(p1.external_item_id, { reactions: 1, comments: 0 });
  assert.deepEqual(await collector.sweep(at(61 * MIN)), { read: 1, changed: 1, failed: 0, stopped: 0, deferred: 0 });
  let rows = await connectorRows(p1.id, 'engagements');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, 1);
  assert.equal(rows[0].note, 'reddit score 0 → 1');
  assert.equal(rows[0].channel_id, reddit.id);
  assert.equal(rows[0].recorded_by_type, 'system');
  assert.equal(new Date(rows[0].bucket_start).getTime(), at(61 * MIN).getTime());
  assert.equal((await connectorRows(p1.id, 'replies')).length, 0, '0 → 0 comments is not a change');
  let p1row = await row(p1.id);
  assert.deepEqual(p1row.engagement, { engagements: 1, replies: 0, read_at: at(61 * MIN).toISOString() });
  assert.equal(new Date(p1row.engagement_next_at).getTime(), at(2 * HOUR + MIN).getTime(), 'young posts are read hourly');

  redditFake.engagement.set(p1.external_item_id, { reactions: 57, comments: 12 });
  await collector.sweep(at(2 * HOUR + 5 * MIN));
  assert.deepEqual(await collector.sweep(at(2 * HOUR + 10 * MIN)), { read: 0, changed: 0, failed: 0, stopped: 0, deferred: 0 }, 'read once per interval');
  redditFake.engagement.set(p1.external_item_id, { reactions: 50, comments: 12 });
  await collector.sweep(at(3 * HOUR + 10 * MIN));
  rows = await connectorRows(p1.id, 'engagements');
  assert.deepEqual(rows.map((r) => r.value), [1, 56, -7], 'a falling score is recorded as a negative change');
  assert.equal(sum(rows), 50, 'the rows add up to the platform value');
  assert.deepEqual((await connectorRows(p1.id, 'replies')).map((r) => r.value), [12]);
  assert.equal(redditFake.engagementCalls.length, 3);

  // 리포트 — 누적형 합이 그대로 맞는다. 기간을 좁히면 그 기간의 증가분.
  const report = await mcp.callTool('get_marketing_report', { campaign_id: campaign.id });
  const redditRow = report.channels.find((c) => c.channel_id === reddit.id);
  assert.equal(redditRow.metrics.engagements, 50);
  assert.equal(redditRow.metrics.replies, 12);
  assert.ok(report.lines.some((l) => l.includes('engagements 50') && l.includes('replies 12')), report.lines.join('\n'));
  assert.ok(report.caveats.some((c) => /connector/.test(c) && /14 days/.test(c)), report.caveats.join('\n'));
  const window = await mcp.callTool('get_marketing_report', { campaign_id: campaign.id, since: at(3 * HOUR).toISOString(), until: at(4 * HOUR).toISOString() });
  assert.equal(window.channels.find((c) => c.channel_id === reddit.id).metrics.engagements, -7);

  const restPost = (await api(`/posts/${p1.id}`)).body;
  assert.deepEqual(restPost.engagement, { engagements: 50, replies: 12, read_at: at(3 * HOUR + 10 * MIN).toISOString() });
  const listed = (await api(`/campaigns/${campaign.id}/metrics`)).body;
  assert.equal(listed.filter((m) => m.source === 'connector' && m.post_id === p1.id).length, 4);
  const overview = await mcp.callTool('get_marketing_campaign', { campaign_id: campaign.id });
  assert.deepEqual(overview.recent_posts.find((p) => p.id === p1.id).engagement, restPost.engagement, 'the agent sees each post\'s engagement');

  // 3. 나이별 간격 · 실패 · 기간 끝(일시정지된 캠페인도 읽는다).
  await collector.sweep(at(2 * DAY));
  assert.equal(new Date((await row(p1.id)).engagement_next_at).getTime(), at(2 * DAY + 3 * HOUR).getTime(), 'after a day: every 3 hours');
  await collector.sweep(at(5 * DAY));
  assert.equal(new Date((await row(p1.id)).engagement_next_at).getTime(), at(5 * DAY + 12 * HOUR).getTime(), 'after three days: every 12 hours');
  redditFake.engagement.delete(p1.external_item_id);
  const missing = await collector.sweep(at(6 * DAY));
  assert.equal(missing.failed, 1);
  p1row = await row(p1.id);
  assert.match(p1row.engagement_error, /did not return/);
  assert.equal(p1row.engagement.engagements, 50, 'a failed read keeps the last value');
  assert.equal(new Date(p1row.engagement_next_at).getTime(), at(6 * DAY + 12 * HOUR).getTime(), 'a failure waits the same interval');
  redditFake.engagement.set(p1.external_item_id, { reactions: 61, comments: 15 });
  await post(`/campaigns/${campaign.id}/status`, { status: 'paused' });
  await collector.sweep(at(13 * DAY + 20 * HOUR));
  p1row = await row(p1.id);
  assert.equal(p1row.engagement_error, '', 'a successful read clears the error');
  assert.equal(p1row.engagement.engagements, 61, 'a paused campaign is still read — reading sends nothing');
  assert.equal(new Date(p1row.engagement_next_at).getTime(), at(14 * DAY).getTime(), 'the last read lands on the window end');
  await post(`/campaigns/${campaign.id}/status`, { status: 'active' });
  redditFake.engagement.set(p1.external_item_id, { reactions: 64, comments: 15 });
  await collector.sweep(at(14 * DAY));
  p1row = await row(p1.id);
  assert.equal(p1row.engagement.engagements, 64);
  assert.equal(p1row.engagement_next_at, null, 'done after the window');
  assert.equal(sum(await connectorRows(p1.id, 'engagements')), 64);
  const callsAfterWindow = redditFake.engagementCalls.length;
  await collector.sweep(at(14 * DAY + HOUR));
  assert.equal(redditFake.engagementCalls.length, callsAfterWindow, 'never read again');

  // 5. claim — 읽는 사이 다른 서버가 맡으면 아무것도 남기지 않고, lease 뒤에 다시 읽는다.
  const p2 = await publish(reddit);
  await backdate(p2.id);
  redditFake.engagement.set(p2.external_item_id, { reactions: 9, comments: 1 });
  override = (outreach) => ({
    engagementRefsPerRequest: 100,
    readEngagement: async (refs) => {
      // 그 사이 lease 가 지나 다른 서버가 이 글을 맡았다.
      await postRepo.createQueryBuilder().update().set({ engagement_rev: () => 'engagement_rev + 1' }).where('id = :id', { id: p2.id }).execute();
      return fakeFor(outreach).readEngagement(refs);
    },
  });
  const raced = await collector.sweep(at(61 * MIN));
  override = null;
  assert.equal(raced.read, 0, 'the claim was lost while reading');
  assert.equal((await connectorRows(p2.id, 'engagements')).length, 0);
  assert.equal((await api(`/posts/${p2.id}`)).body.engagement, null);
  await collector.sweep(at(80 * MIN));
  assert.equal((await row(p2.id)).engagement.engagements, 9, 'read again after the lease');

  // 4. rate limit 몫 · 묶음 · 채널 전체 오류.
  const p3 = await publish(reddit);
  const p4 = await publish(reddit);
  // 같은 시각이면 순서가 DB 마다 다르다 — 1 분씩 띄운다.
  for (const [i, p] of [p2, p3, p4].entries()) await postRepo.update(p.id, { published_at: at(0), engagement_next_at: at(DAY + i * MIN) });
  redditFake.engagement.set(p3.external_item_id, { reactions: 2, comments: 0 });
  redditFake.engagement.set(p4.external_item_id, { reactions: 4, comments: 0 });
  await ds.getRepository('OutreachChannel').update(reddit.outreach_channel_id, { rate_limit_per_hour: 4 });
  collector.rateLimiter = new OutreachRateLimiter();
  collector.rateLimiter.checkAndRecord(reddit.outreach_channel_id, 4);
  collector.rateLimiter.checkAndRecord(reddit.outreach_channel_id, 4);
  const callsBefore = redditFake.engagementCalls.length;
  const starved = await collector.sweep(at(DAY + 5 * MIN));
  assert.equal(starved.deferred, 3, 'half of the hourly cap is left to publishing and polling');
  assert.equal(redditFake.engagementCalls.length, callsBefore);
  assert.equal(new Date((await row(p3.id)).engagement_next_at).getTime(), at(DAY + MIN).getTime(), 'a deferred post stays due');
  collector.rateLimiter = new OutreachRateLimiter();
  collector.rateLimiter.checkAndRecord(reddit.outreach_channel_id, 4);
  redditFake.engagementRefsPerRequest = 2;
  const partial = await collector.sweep(at(DAY + 5 * MIN));
  assert.equal(partial.read, 2, 'one request of two posts fits in the budget');
  assert.equal(partial.deferred, 1);
  assert.deepEqual(redditFake.engagementCalls.at(-1), [p2.external_item_id, p3.external_item_id]);
  assert.equal((await row(p4.id)).engagement_rev, 0, 'the deferred post was not claimed');
  await ds.getRepository('OutreachChannel').update(reddit.outreach_channel_id, { rate_limit_per_hour: 0 });
  redditFake.engagementRefsPerRequest = 1;
  override = () => ({ engagementRefsPerRequest: 1, readEngagement: async () => { throw new OutreachChannelRateLimitedError('channel cap', 60_000); } });
  for (const [i, p] of [p3, p4].entries()) await postRepo.update(p.id, { engagement_next_at: at(DAY + HOUR + i * MIN) });
  const blocked = await collector.sweep(at(DAY + HOUR + 5 * MIN));
  override = null;
  assert.equal(blocked.failed, 1);
  assert.equal(blocked.deferred, 1, 'a rate-limited channel is not asked again in the same sweep');
  assert.match((await row(p3.id)).engagement_error, /channel cap/);

  // GitHub · 답글(댓글 수 없음).
  const g1 = await publish(github);
  await backdate(g1.id);
  githubFake.engagement.set(g1.external_item_id, { reactions: 5, comments: 2 });
  redditFake.threads.set('t3_thread', { target: 'selfhosted', permalink: 'https://www.reddit.com/r/selfhosted/comments/thread', title: 'A thread' });
  const r1 = await publish(reddit, { reply_to: 't3_thread', title: undefined });
  assert.equal(r1.kind, 'reply');
  await backdate(r1.id);
  redditFake.engagement.set(r1.external_item_id, { reactions: 3, comments: null });
  await collector.sweep(at(61 * MIN));
  assert.deepEqual((await connectorRows(g1.id, 'engagements')).map((r) => r.note), ['GitHub reactions 0 → 5']);
  assert.deepEqual((await connectorRows(g1.id, 'replies')).map((r) => r.note), ['GitHub comments 0 → 2']);
  const replyJson = (await api(`/posts/${r1.id}`)).body.engagement;
  assert.equal(replyJson.engagements, 3);
  assert.equal(replyJson.replies, null, 'a reply has no comment count of its own');

  // 6. 기능 전 게시물 · 보관된 캠페인.
  const legacy = await postRepo.save(postRepo.create({
    account_id: account.id, campaign_id: campaign.id, channel_id: reddit.id, kind: 'post', title: 'Old', body: 'old', final_body: 'old',
    status: 'published', external_item_id: 't3_legacy', permalink: 'https://www.reddit.com/r/selfhosted/comments/legacy', published_at: at(13 * DAY),
  }));
  const ancient = await postRepo.save(postRepo.create({
    account_id: account.id, campaign_id: campaign.id, channel_id: reddit.id, kind: 'post', title: 'Older', body: 'older', final_body: 'older',
    status: 'published', external_item_id: 't3_ancient', permalink: 'https://www.reddit.com/r/selfhosted/comments/ancient', published_at: at(-10 * DAY),
  }));
  assert.equal(legacy.engagement_next_at, null);
  redditFake.engagement.set('t3_legacy', { reactions: 7, comments: 3 });
  redditFake.engagement.set('t3_ancient', { reactions: 70, comments: 30 });
  await collector.sweep(at(13 * DAY + 2 * HOUR));
  assert.equal((await row(legacy.id)).engagement.engagements, 7, 'a post published before this feature is picked up inside its window');
  assert.equal((await row(ancient.id)).engagement_next_at, null, 'one older than the window is left alone');
  assert.equal((await row(ancient.id)).engagement_rev, 0);

  const archivedCampaign = await makeCampaign('Archived');
  const archivedReddit = await outreachChannel(archivedCampaign, 'reddit', 'homelab');
  const q1 = await publish(archivedReddit, { campaign_id: archivedCampaign.id });
  await backdate(q1.id);
  fakeFor({ id: archivedReddit.outreach_channel_id }).engagement.set(q1.external_item_id, { reactions: 1, comments: 0 });
  assert.equal((await post(`/campaigns/${archivedCampaign.id}/status`, { status: 'archived' })).status, 200);
  await collector.sweep(at(61 * MIN));
  const q1row = await row(q1.id);
  assert.equal(q1row.engagement_next_at, null, 'an archived campaign is not read');
  assert.equal(q1row.engagement_error, 'campaign archived');
  assert.ok(q1row.engagement_rev > 0, 'stopped posts are not picked up again as untracked');
  assert.equal((await connectorRows(q1.id, 'engagements')).length, 0);

  // 7. 이중 집계 방지 — 서버가 읽는 채널의 engagements · replies 는 기록하지 못한다.
  const rec = (observations) => mcp.callTool('record_marketing_metrics', { campaign_id: campaign.id, observations });
  assert.match(errText(await rec([{ metric: 'engagements', value: 5, channel_id: reddit.id }])), /read from the platform/);
  assert.match(errText(await rec([{ metric: 'replies', value: 5, post_id: g1.id }])), /read from the platform/);
  const humanRec = await post(`/campaigns/${campaign.id}/metrics`, { observations: [{ metric: 'replies', value: 1, channel_id: github.id }] });
  assert.equal(humanRec.status, 400, humanRec.text);
  const allowed = await rec([
    { metric: 'impressions', value: 900, channel_id: reddit.id },
    { metric: 'engagements', value: 4, channel_id: forum.id },
    { metric: 'engagements', value: 2 },
  ]);
  assert.equal(allowed.recorded?.length, 3, JSON.stringify(allowed));
});
