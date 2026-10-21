// Marketing 커뮤니티 게시 — docs/marketing.md "커뮤니케이션".
//
// 고정하는 것:
//   1. 에이전트 초안: 채널 종류가 capability 를 정한다(메일 채널은 email), 근거(rationale) 필수, 새 reddit 글은 제목 필수,
//      reply_to 형식 검사, dedupe_key, 일일 상한, 본문의 추적 링크 코드 수집. 활성 채널에만 쓴다.
//   2. 승인 화면의 preview_body = 실제로 나갈 본문(공개 문구 포함). 승인 때 사람이 고친 본문이 그대로 게시된다.
//   3. outreach 채널은 커넥터로 게시(새 글 → publish, 답글 → reply)되고 permalink 가 남는다. 실패는 failed 로 남고
//      자동 재시도하지 않으며, 사람이 retry 한다. 글은 자기 채널의 대상(subreddit)으로만 간다.
//   4. manual 채널: 승인 → approved, 사람이 permalink(http/https)를 기록하면 published.
//   5. 일시정지된 채널 · 캠페인에서는 승인되지 않는다. 거부. 감사 로그.
//
// 실행: node --test --test-force-exit test/marketing-posts.test.mjs (dist 필요)

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAccount, createAgent, createApiKey, createUser } from './helpers/fixtures.mjs';
import { McpClient } from './helpers/mcp-client.mjs';
import { encrypt } from '../dist/services/encryption.service.js';
import { MarketingPostService } from '../dist/modules/marketing/marketing-post.service.js';
import { FakeOutreachConnector } from '../dist/modules/outreach/connectors/fake.connector.js';

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

test('marketing posts: drafts, approval with edits, connector publish/reply, failures, manual channels', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(async () => { await closeTestApp(app); });
  const { getDataSourceToken, AuthService } = modules;
  const ds = app.get(getDataSourceToken());
  const base = `http://127.0.0.1:${port}`;

  const fake = new FakeOutreachConnector();
  let failNext = false;
  const postService = app.get(MarketingPostService);
  const seenChannels = [];
  postService.connectorFactory = async (outreach) => {
    seenChannels.push(outreach.id);
    if (failNext) {
      failNext = false;
      return { fetchInbound: async () => [], publish: async () => { throw new Error('reddit 503'); }, reply: async () => { throw new Error('reddit 503'); } };
    }
    return fake;
  };

  const account = await createAccount(app, getDataSourceToken, 'mkt-posts');
  const admin = await createUser(app, getDataSourceToken, { name: 'mkt-posts-admin', role: 'admin' });
  const H = { Authorization: `Bearer ${app.get(AuthService).createSession(admin.id)}`, 'X-Account-Id': account.id, 'Content-Type': 'application/json' };
  const api = (path, init = {}) => call(`${base}/api/marketing${path}`, { headers: H, ...init });
  const post = (path, body = {}) => api(path, { method: 'POST', body: JSON.stringify(body) });

  const agent = await createAgent(app, getDataSourceToken, account.id, { name: 'mkt-posts-agent', type: 'claude', runtime: true });
  const campaign = (await post('/campaigns', {
    name: 'Posts', agent_runtime: agent.runtime_spec, capabilities: ['community_post'],
    disclosure: '— Posted by the AWB team (AI-assisted).', limits: { drafts_per_day: 6 },
  })).body;
  assert.equal((await post(`/campaigns/${campaign.id}/status`, { status: 'active' })).status, 200);

  const cred = await ds.getRepository('Credential').save(ds.getRepository('Credential').create({
    account_id: account.id, name: 'reddit', description: '', provider: 'custom',
    encrypted_data: encrypt(JSON.stringify({ username: 'bot', token: 'x', client_id: 'c', client_secret: 's' })),
  }));
  const reddit = (await post(`/campaigns/${campaign.id}/channels`, { platform: 'reddit', target: 'selfhosted' })).body;
  assert.equal((await post(`/channels/${reddit.id}/approve`, { mode: 'outreach', create_outreach: { credential_id: cred.id } })).body.status, 'active');
  const forum = (await post(`/campaigns/${campaign.id}/channels`, { platform: 'forum', target: 'https://forum.example.org/c/tools' })).body;
  assert.equal((await post(`/channels/${forum.id}/approve`, { mode: 'manual' })).body.status, 'active');
  const mail = (await post(`/campaigns/${campaign.id}/channels`, { platform: 'email', target: 'early' })).body;
  const proposed = (await post(`/campaigns/${campaign.id}/channels`, { platform: 'reddit', target: 'programming' })).body;

  const key = await createApiKey(app, getDataSourceToken, agent.id, { accountId: account.id, label: 'mkt-posts' });
  const mcp = new McpClient({ baseUrl: base, apiKey: key.raw_key });
  t.after(() => mcp.close().catch(() => {}));
  const errText = (r) => (typeof r?.error === 'string' ? r.error : r?.error?.error || JSON.stringify(r));
  const draft = (fields) => mcp.callTool('draft_marketing_post', { campaign_id: campaign.id, rationale: 'Release week for self-hosters.', ...fields });

  // 1. 초안 규칙
  assert.match(errText((await draft({ channel_id: mail.id, title: 'Hi', body: 'x' }))), /channel "early" is proposed|capability "email"/);
  assert.match(errText((await draft({ channel_id: proposed.id, title: 'Hi', body: 'x' }))), /only active channels/);
  assert.match(errText((await draft({ channel_id: reddit.id, body: 'no title' }))), /title is required/);
  assert.match(errText((await draft({ channel_id: reddit.id, title: 'x', body: 'y', rationale: '' }))), /rationale/);
  assert.match(errText((await draft({ channel_id: reddit.id, body: 'y', reply_to: '12345' }))), /fullname/);
  const d1 = await draft({
    channel_id: reddit.id, title: 'AWB 1.0 — run agents on your own hardware',
    body: 'We built AWB… details: https://awb.example.com/api/m/Abc123XYZ789 and docs.', dedupe_key: 'launch-reddit',
  });
  assert.equal(d1.duplicate, false, JSON.stringify(d1));
  assert.equal(d1.post.status, 'draft');
  assert.deepEqual(d1.post.link_codes, ['Abc123XYZ789']);
  assert.match(d1.post.preview_body, /— Posted by the AWB team \(AI-assisted\)\.$/, 'the preview is what will go out');
  assert.equal((await draft({ channel_id: reddit.id, title: 'x', body: 'y', dedupe_key: 'launch-reddit' })).duplicate, true);

  // 2·3. 승인(수정 포함) → 게시
  const listed = (await api(`/campaigns/${campaign.id}/posts?status=draft`)).body;
  assert.equal(listed.length, 1);
  const approved = await post(`/posts/${d1.post.id}/approve`, { body: 'Edited by a human. https://awb.example.com/api/m/Abc123XYZ789' });
  assert.equal(approved.status, 200, approved.text);
  assert.equal(approved.body.status, 'published');
  assert.equal(approved.body.edited, true);
  assert.match(approved.body.permalink, /^fake:\/\/post\//);
  assert.equal(fake.published.length, 1);
  assert.equal(fake.published[0].target, 'selfhosted', 'posts go only to their channel\'s target');
  assert.equal(fake.published[0].body, 'Edited by a human. https://awb.example.com/api/m/Abc123XYZ789\n\n— Posted by the AWB team (AI-assisted).');
  assert.equal((await post(`/posts/${d1.post.id}/approve`, {})).status, 409, 'approve once');

  // 답글: fullname 만으로는 어느 subreddit 인지 모른다 — 커넥터에 물어 채널 밖이면 초안을 만들지 않는다.
  fake.threads.set('t3_elsewhere', { target: 'programming', permalink: 'https://www.reddit.com/r/programming/comments/elsewhere', title: 'Off-channel thread' });
  fake.threads.set('t1_abc123', { target: 'SelfHosted', permalink: 'https://www.reddit.com/r/selfhosted/comments/x/y/abc123', title: 'My setup' });
  assert.match(errText(await draft({ channel_id: reddit.id, body: 'hi', reply_to: 't3_elsewhere' })), /outside this channel/);
  assert.match(errText(await draft({ channel_id: reddit.id, body: 'hi', reply_to: 't3_unknown' })), /could not verify reply_to/);
  const d2 = await draft({ channel_id: reddit.id, body: 'Thanks for the feedback — fixed in 1.0.1.', reply_to: 't1_abc123' });
  assert.equal(d2.post.kind, 'reply');
  assert.deepEqual(d2.post.reply_context, { target: 'SelfHosted', permalink: 'https://www.reddit.com/r/selfhosted/comments/x/y/abc123', title: 'My setup' },
    'the approver sees where the reply will land');
  const replied = await post(`/posts/${d2.post.id}/approve`, {});
  assert.equal(replied.body.status, 'published', replied.text);
  assert.deepEqual(fake.replies[0], { threadRef: 't1_abc123', body: 'Thanks for the feedback — fixed in 1.0.1.\n\n— Posted by the AWB team (AI-assisted).' });

  failNext = true;
  const d3 = await draft({ channel_id: reddit.id, title: 'Second post', body: 'More news.' });
  const failed = await post(`/posts/${d3.post.id}/approve`, {});
  assert.equal(failed.body.status, 'failed');
  assert.match(failed.body.error, /reddit 503/);
  assert.equal(fake.published.length, 1, 'no automatic retry');
  const retried = await post(`/posts/${d3.post.id}/retry`, {});
  assert.equal(retried.body.status, 'published', retried.text);
  assert.equal(fake.published.length, 2);

  // 4. manual
  const d4 = await draft({ channel_id: forum.id, body: 'Forum thread text.' });
  const manual = await post(`/posts/${d4.post.id}/approve`, {});
  assert.equal(manual.body.status, 'approved');
  assert.equal((await post(`/posts/${d4.post.id}/mark-published`, { permalink: 'javascript:alert(1)' })).status, 400);
  const recorded = await post(`/posts/${d4.post.id}/mark-published`, { permalink: 'https://forum.example.org/t/awb/123' });
  assert.equal(recorded.body.status, 'published');

  // 5. 일시정지 · 거부 · 상한 · 감사
  const d5 = await draft({ channel_id: reddit.id, title: 'Third', body: 'x' });
  await post(`/channels/${reddit.id}/pause`);
  assert.equal((await post(`/posts/${d5.post.id}/approve`, {})).status, 409, 'paused channels send nothing');
  await post(`/channels/${reddit.id}/resume`);
  await post(`/campaigns/${campaign.id}/status`, { status: 'paused' });
  assert.equal((await post(`/posts/${d5.post.id}/approve`, {})).status, 409, 'paused campaigns send nothing');
  await post(`/campaigns/${campaign.id}/status`, { status: 'active' });
  assert.equal((await post(`/posts/${d5.post.id}/reject`, { note: 'off-topic' })).body.status, 'rejected');
  await draft({ channel_id: forum.id, body: 'one more' });
  const capped = await draft({ channel_id: forum.id, body: 'over the limit' });
  assert.match(errText(capped), /daily limit/);

  const actions = new Set((await api(`/campaigns/${campaign.id}/audit?limit=500`)).body.map((e) => e.action));
  for (const a of ['post.drafted', 'post.approved', 'post.published', 'post.failed', 'post.retried', 'post.rejected']) {
    assert.ok(actions.has(a), `audit has ${a}`);
  }
  const overview = await mcp.callTool('get_marketing_campaign', { campaign_id: campaign.id });
  assert.ok(overview.recent_posts.some((p) => p.status === 'rejected' && p.decision_note === 'off-topic'), 'the agent sees why a post was rejected');
});
