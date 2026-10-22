// Marketing 채널 탐색 · 승인 — docs/marketing.md "채널 탐색".
//
// 고정하는 것:
//   1. 에이전트 제안은 capability channel_discovery 가 켜져 있어야 하고, 근거(rationale · evidence_urls)가 필수다.
//      같은 (플랫폼, 대상)은 다시 만들지 않고(duplicate), 일일 상한을 넘으면 거부된다.
//   2. 대상 표기가 정규화된다(r/SelfHosted → SelfHosted, github URL → owner/repo).
//   3. 승인은 사람만: manual → active, reddit 을 연결 없이 승인 → awaiting_credential, credential 로 connect 하면
//      OutreachChannel 이 생기되 폴링은 꺼져 있고(collect_feedback 기본 끔) 대상이 그 하나로 화이트리스트된다.
//      대상을 화이트리스트하지 않은 기존 OutreachChannel 에는 잇지 못한다. agent_env credential 은 거부된다.
//   4. 메일 채널은 발신자 · 우편 주소 · 목록 · 메일 credential(provider + api_key)이 있어야 활성화된다.
//   5. 거부 · 일시정지 · 재개와 감사 로그, 캠페인 삭제 시 채널 정리.
//
// 실행: node --test --test-force-exit test/marketing-channels.test.mjs (dist 필요)

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAccount, createAgent, createApiKey, createUser } from './helpers/fixtures.mjs';
import { McpClient } from './helpers/mcp-client.mjs';
import { encrypt } from '../dist/services/encryption.service.js';
import { normalizeChannelTarget } from '../dist/modules/marketing/marketing-channel.logic.js';

process.env.PORT = process.env.TEST_SERVER_PORT || '0';
process.env.AGENT_DEV_MODE = 'false';
process.env.OUTREACH_SCHEDULER_ENABLED = 'false';

async function call(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: res.status, body, text };
}

test('channel target normalization', () => {
  assert.deepEqual(normalizeChannelTarget('reddit', 'r/SelfHosted'), { target: 'SelfHosted', key: 'selfhosted' });
  assert.deepEqual(normalizeChannelTarget('reddit', 'https://www.reddit.com/r/selfhosted/'), { target: 'selfhosted', key: 'selfhosted' });
  assert.throws(() => normalizeChannelTarget('reddit', 'r/'), /subreddit/);
  assert.deepEqual(normalizeChannelTarget('github', 'https://github.com/Acme/Widget.git'), { target: 'Acme/Widget', key: 'acme/widget' });
  assert.throws(() => normalizeChannelTarget('github', 'acme'), /owner\/repo/);
  assert.equal(normalizeChannelTarget('hacker_news', 'https://news.ycombinator.com/show').target, 'https://news.ycombinator.com/show');
  assert.throws(() => normalizeChannelTarget('forum', 'javascript:alert(1)'), /http/);
  assert.equal(normalizeChannelTarget('newsletter', 'Early Access').key, 'early access');
});

test('marketing channels: agent proposals, human approval modes, outreach linkage, email config, audit', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(async () => { await closeTestApp(app); });
  const { getDataSourceToken, AuthService } = modules;
  const ds = app.get(getDataSourceToken());
  const base = `http://127.0.0.1:${port}`;

  const account = await createAccount(app, getDataSourceToken, 'mkt-ch');
  const admin = await createUser(app, getDataSourceToken, { name: 'mkt-ch-admin', role: 'admin' });
  const headers = { Authorization: `Bearer ${app.get(AuthService).createSession(admin.id)}`, 'X-Account-Id': account.id, 'Content-Type': 'application/json' };
  const api = (path, init = {}) => call(`${base}/api/marketing${path}`, { headers, ...init });
  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });

  const agent = await createAgent(app, getDataSourceToken, account.id, { name: 'mkt-ch-agent', type: 'claude', runtime: true });
  const created = await post('/campaigns', { name: 'Channels', agent_runtime: agent.runtime_spec, capabilities: ['community_post'], limits: { channel_proposals_per_day: 3 } });
  assert.equal(created.status, 201, created.text);
  const campaign = created.body;
  assert.equal((await post(`/campaigns/${campaign.id}/status`, { status: 'active' })).status, 200);

  const key = await createApiKey(app, getDataSourceToken, agent.id, { accountId: account.id, label: 'mkt-ch' });
  const mcp = new McpClient({ baseUrl: base, apiKey: key.raw_key });
  t.after(() => mcp.close().catch(() => {}));
  const proposal = {
    campaign_id: campaign.id,
    platform: 'reddit',
    target: 'r/SelfHosted',
    rationale: 'Self-hosters run agent tooling on their own boxes.',
    evidence_urls: ['https://www.reddit.com/r/selfhosted/about/'],
    rules_summary: 'Rule 3: self-promotion is allowed on weekends with a [Release] flair.',
    rules_url: 'https://www.reddit.com/r/selfhosted/wiki/rules',
    audience_size: 450000,
  };

  // 1. capability · 근거 · 중복 · 일일 상한
  const noCap = await mcp.callTool('propose_marketing_channel', proposal);
  assert.equal(noCap.isError, true);
  assert.match(JSON.stringify(noCap.error), /channel_discovery/);
  assert.equal((await api(`/campaigns/${campaign.id}`, { method: 'PATCH', body: JSON.stringify({ capabilities: ['community_post', 'channel_discovery', 'email'] }) })).status, 200);
  const noEvidence = await mcp.callTool('propose_marketing_channel', { ...proposal, evidence_urls: ['javascript:alert(1)'] });
  assert.equal(noEvidence.isError, true, 'non-http evidence is rejected');
  const first = await mcp.callTool('propose_marketing_channel', proposal);
  assert.equal(first.duplicate, false, JSON.stringify(first));
  assert.equal(first.channel.target, 'SelfHosted');
  assert.equal(first.channel.status, 'proposed');
  assert.equal(first.channel.kind, 'outreach');
  const again = await mcp.callTool('propose_marketing_channel', { ...proposal, target: 'selfhosted' });
  assert.equal(again.duplicate, true);
  assert.equal(again.channel.id, first.channel.id);
  const hn = await mcp.callTool('propose_marketing_channel', { ...proposal, platform: 'hacker_news', target: 'https://news.ycombinator.com/show', evidence_urls: ['https://news.ycombinator.com/showhn.html'] });
  assert.equal(hn.channel.kind, 'manual');
  const news = await mcp.callTool('propose_marketing_channel', { ...proposal, platform: 'email', target: 'early-access', evidence_urls: ['https://awb.example.com/signup'] });
  assert.equal(news.channel.kind, 'email');
  const capped = await mcp.callTool('propose_marketing_channel', { ...proposal, platform: 'github', target: 'acme/widget', evidence_urls: ['https://github.com/acme/widget'] });
  assert.equal(capped.isError, true);
  assert.match(JSON.stringify(capped.error), /daily limit/);

  const overview = await mcp.callTool('get_marketing_campaign', { campaign_id: campaign.id });
  assert.equal(overview.channels.length, 3);

  // 3. 승인 방식
  const manual = await post(`/channels/${hn.channel.id}/approve`, { mode: 'manual', note: 'post it by hand' });
  assert.equal(manual.status, 200, manual.text);
  assert.equal(manual.body.status, 'active');
  assert.equal(manual.body.decided_by, admin.id);
  assert.equal((await post(`/channels/${hn.channel.id}/approve`, { mode: 'manual' })).status, 409, 'approve once');

  const waiting = await post(`/channels/${first.channel.id}/approve`, { mode: 'outreach' });
  assert.equal(waiting.status, 200, waiting.text);
  assert.equal(waiting.body.status, 'awaiting_credential');

  const credRepo = ds.getRepository('Credential');
  const mkCred = (name, fields, extra = {}) => credRepo.save(credRepo.create({
    account_id: account.id, name, description: '', provider: 'custom', encrypted_data: encrypt(JSON.stringify(fields)), ...extra,
  }));
  const redditCred = await mkCred('reddit-bot', { username: 'bot', token: 'x', client_id: 'c', client_secret: 's' });
  const exposed = await mkCred('exposed', { token: 'x' }, { agent_env: true });
  assert.equal((await post(`/channels/${first.channel.id}/connect`, { create_outreach: { credential_id: exposed.id } })).status, 400,
    'a credential the agent can read in its env is refused');

  const outreachRepo = ds.getRepository('OutreachChannel');
  const unrelated = await outreachRepo.save(outreachRepo.create({
    account_id: account.id, kind: 'reddit', name: 'other', targets: ['programming'], credential_id: redditCred.id, enabled: false,
  }));
  const wrongTarget = await post(`/channels/${first.channel.id}/connect`, { outreach_channel_id: unrelated.id });
  assert.equal(wrongTarget.status, 400);
  assert.match(wrongTarget.body.error, /whitelist/);

  const connected = await post(`/channels/${first.channel.id}/connect`, { create_outreach: { credential_id: redditCred.id } });
  assert.equal(connected.status, 200, connected.text);
  assert.equal(connected.body.status, 'active');
  const outreach = await outreachRepo.findOneBy({ id: connected.body.outreach_channel_id });
  assert.deepEqual(outreach.targets, ['SelfHosted']);
  assert.equal(outreach.enabled, false, 'polling a general community is opt-in');
  assert.equal(outreach.deploy_post_mode, 'off');
  assert.deepEqual(outreach.target_tags.sort(), ['marketing', `campaign:${campaign.slug}`].sort());

  // 4. 메일 채널
  const noProvider = await mkCred('mail-bad', { api_key: 're_x' });
  const mailCred = await mkCred('mail', { provider: 'resend', api_key: 're_x' });
  const brand = (await post('/brands', { name: 'AWB' })).body;
  const email = { brand_id: brand.id, credential_id: mailCred.id, from_name: 'AWB', from_address: 'hello@awb.example.com', list_name: 'Early Access', postal_address: '' };
  assert.equal((await post(`/channels/${news.channel.id}/approve`, { mode: 'email', email })).status, 400, 'postal address is mandatory');
  assert.equal((await post(`/channels/${news.channel.id}/approve`, { mode: 'email', email: { ...email, postal_address: 'Seoul', credential_id: noProvider.id } })).status, 400,
    'the credential must name a provider');
  const mail = await post(`/channels/${news.channel.id}/approve`, { mode: 'email', email: { ...email, postal_address: '1 Main St, Seoul' } });
  assert.equal(mail.status, 200, mail.text);
  assert.equal(mail.body.kind, 'email');
  assert.equal(mail.body.email.ad_label, '(광고)', 'the ad label defaults to (광고)');
  assert.equal(mail.body.email.list_name, 'early access');
  assert.equal(mail.body.email.provider, 'resend');
  assert.ok(!JSON.stringify(mail.body).includes('re_x'), 'secrets never leave the credential');
  assert.equal((await post(`/channels/${hn.channel.id}/approve`, { mode: 'email', email })).status, 409);

  // 5. 일시정지 · 재개 · 거부 · 감사 · 정리
  assert.equal((await post(`/channels/${hn.channel.id}/pause`, {})).body.status, 'paused');
  assert.equal((await post(`/channels/${hn.channel.id}/pause`, {})).status, 409);
  assert.equal((await post(`/channels/${hn.channel.id}/resume`, {})).body.status, 'active');
  const humanAdded = await post(`/campaigns/${campaign.id}/channels`, { platform: 'forum', target: 'https://forum.example.org/c/tools', name: 'Tools forum' });
  assert.equal(humanAdded.status, 201, humanAdded.text);
  assert.equal(humanAdded.body.proposed_by_type, 'user', 'humans may add channels without evidence');
  const rejected = await post(`/channels/${humanAdded.body.id}/reject`, { note: 'not our audience' });
  assert.equal(rejected.body.status, 'rejected');
  const edited = await api(`/channels/${hn.channel.id}`, { method: 'PATCH', body: JSON.stringify({ guidelines: 'Show HN only, once.' }) });
  assert.equal(edited.body.guidelines, 'Show HN only, once.');

  const audit = (await api(`/campaigns/${campaign.id}/audit`)).body.map((e) => e.action);
  for (const action of ['channel.proposed', 'channel.approved', 'channel.awaiting_credential', 'channel.connected', 'channel.rejected', 'channel.paused', 'channel.resumed', 'channel.updated']) {
    assert.ok(audit.includes(action), `audit has ${action}`);
  }
  const agentProposal = (await api(`/campaigns/${campaign.id}/audit?limit=500`)).body.find((e) => e.action === 'channel.proposed' && e.entity_id === first.channel.id);
  assert.equal(agentProposal.actor_type, 'agent');

  assert.equal((await api(`/campaigns/${campaign.id}`, { method: 'DELETE' })).status, 200);
  assert.equal(await ds.getRepository('MarketingChannel').countBy({ campaign_id: campaign.id }), 0, 'channels go with the campaign');
});
