// Marketing 예산 편성 · 지출 · 결제 · 원장 — docs/marketing.md "예산 편성 · 집행 · 결제".
//
// 고정하는 것:
//   1. 편성이 없는 채널 · 허용 목록 밖 수취인 · 다른 통화 · 건당 상한 초과 · 부동소수 금액은 요청 단계에서 거부되고
//      (저장되지 않고) 거부 사유가 감사 로그에 남는다. dedupe_key 로 같은 요청이 두 번 쌓이지 않는다.
//   2. 편성 승인은 marketing.approve_spend 만, 합이 기간 상한을 넘으면 거부, 새 편성이 이전 것을 대체한다.
//   3. 지출 승인: 화면이 본 payload_sha256 이 아니면 거부, 2인 규칙(같은 사람 두 번 불가), 승인 = reserve 원장 행.
//      동시 승인 경합에서 한도를 넘는 쪽은 거부된다(이중 지출 없음).
//   4. manual: 거래 id 없이 "결제 완료" 불가, paid → release+capture, failed → release, 환불은 결제액 안에서만.
//   5. webhook: 서명 · Idempotency-Key · payload 해시가 실린 요청을 보내고, 2xx+txn → paid, 5xx → unknown(예산 유지,
//      사람이 대조), 4xx → failed(예산 해제). 실행 중 재시작 → unknown. 결제 방식 변경은 approve_spend 만.
//   6. 만료(결정 없음 = 거부), 캠페인 일시정지 → 대기 요청 취소, 원장이 생기면 통화 변경 · 삭제 불가.
//   7. 에이전트 MCP 표면에는 승인 · 결제 기록 툴이 없다.
//
// 실행: node --test --test-force-exit test/marketing-spend.test.mjs (dist 필요)

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAccount, createAgent, createApiKey, createUser } from './helpers/fixtures.mjs';
import { McpClient } from './helpers/mcp-client.mjs';
import { encrypt } from '../dist/services/encryption.service.js';
import { MarketingSpendService } from '../dist/modules/marketing/marketing-spend.service.js';

process.env.PORT = process.env.TEST_SERVER_PORT || '0';
process.env.AGENT_DEV_MODE = 'false';
process.env.MARKETING_SCHEDULER_ENABLED = 'false';
process.env.OUTREACH_SCHEDULER_ENABLED = 'false';

const WEBHOOK_SECRET = 'whsec_0123456789abcdef';

async function call(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: res.status, body, text };
}

/** 운영자 결제 엔드포인트 흉내 — 서명을 검증하고, 지정한 응답을 순서대로 준다. */
async function startFakePaymentServer() {
  const seen = [];
  const replies = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const sig = String(req.headers['x-awb-signature'] || '');
      const m = sig.match(/^t=(\d+),v1=([0-9a-f]{64})$/);
      const valid = !!m && createHmac('sha256', WEBHOOK_SECRET).update(`${m[1]}.${body}`).digest('hex') === m[2];
      seen.push({ headers: req.headers, body: JSON.parse(body), valid });
      const reply = replies.shift() || { status: 200, body: { transaction_id: `txn_${seen.length}` } };
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    seen,
    replies,
    url: `http://127.0.0.1:${server.address().port}/pay`,
    close: () => new Promise((r) => server.close(r)),
  };
}

test('marketing spend: allocations, approvals, ledger, manual + webhook payments, reconciliation', async (t) => {
  const payments = await startFakePaymentServer();
  t.after(() => payments.close());
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(async () => { await closeTestApp(app); });
  const { getDataSourceToken, AuthService } = modules;
  const ds = app.get(getDataSourceToken());
  const base = `http://127.0.0.1:${port}`;
  const spendService = app.get(MarketingSpendService);

  const account = await createAccount(app, getDataSourceToken, 'mkt-spend');
  const approverA = await createUser(app, getDataSourceToken, { name: 'mkt-approver-a', role: 'admin' });
  const approverB = await createUser(app, getDataSourceToken, { name: 'mkt-approver-b', role: 'admin' });
  const marketer = await createUser(app, getDataSourceToken, { name: 'mkt-marketer', role: 'user' });
  await ds.getRepository('User').update(marketer.id, { permissions: JSON.stringify(['marketing.manage']) });
  const treasurer = await createUser(app, getDataSourceToken, { name: 'mkt-treasurer', role: 'user' });
  await ds.getRepository('User').update(treasurer.id, { permissions: JSON.stringify(['marketing.approve_spend']) });
  const auth = (user) => ({ Authorization: `Bearer ${app.get(AuthService).createSession(user.id)}`, 'X-Account-Id': account.id, 'Content-Type': 'application/json' });
  const A = auth(approverA);
  const B = auth(approverB);
  const M = auth(marketer);
  const T = auth(treasurer);
  const api = (path, headers, init = {}) => call(`${base}/api/marketing${path}`, { headers, ...init });
  const post = (path, headers, body = {}) => api(path, headers, { method: 'POST', body: JSON.stringify(body) });
  const patch = (path, headers, body) => api(path, headers, { method: 'PATCH', body: JSON.stringify(body) });

  const agent = await createAgent(app, getDataSourceToken, account.id, { name: 'mkt-spend-agent', type: 'claude', runtime: true });
  const created = await post('/campaigns', A, {
    name: 'Spend',
    agent_runtime: agent.runtime_spec,
    capabilities: ['paid_spend'],
    currency: 'KRW',
    budget_total_minor: 100000,
    budget_period: 'month',
    budget_period_minor: 60000,
    max_transaction_minor: 50000,
    dual_approval_threshold_minor: 20000,
    payees: [{ name: 'Ads Co', ref: 'ads-acct-7' }],
    limits: { spend_requests_per_day: 50 },
  });
  assert.equal(created.status, 201, created.text);
  const campaign = created.body;
  assert.equal((await post(`/campaigns/${campaign.id}/status`, A, { status: 'active' })).status, 200);
  const channel = (await post(`/campaigns/${campaign.id}/channels`, A, { platform: 'newsletter', target: 'Indie Weekly', name: 'Indie Weekly' })).body;
  assert.equal((await post(`/channels/${channel.id}/approve`, A, { mode: 'manual' })).body.status, 'active');

  const key = await createApiKey(app, getDataSourceToken, agent.id, { accountId: account.id, label: 'mkt-spend' });
  const mcp = new McpClient({ baseUrl: base, apiKey: key.raw_key });
  t.after(() => mcp.close().catch(() => {}));
  // 스키마 위반(예: 정수가 아닌 금액)은 SDK 가 프로토콜 오류로 돌려줄 수 있다 — 둘 다 "거부" 로 본다.
  const ask = async (fields) => {
    try {
      return await mcp.callTool('request_marketing_spend', {
        campaign_id: campaign.id, channel_id: channel.id, currency: 'KRW', payee: 'Ads Co',
        purpose: 'Sponsored slot', expected_outcome: '200 clicks, tracked by link', ...fields,
      });
    } catch (e) {
      return { isError: true, error: String(e?.message || e) };
    }
  };
  const audit = async () => (await api(`/campaigns/${campaign.id}/audit?limit=500`, A)).body;
  const budget = async () => (await api(`/campaigns/${campaign.id}/budget`, A)).body;

  // 7. 승인 · 결제 기록 툴은 없다
  const listed = await mcp.listTools();
  const names = (Array.isArray(listed) ? listed : listed?.tools || []).map((x) => x.name).filter((n) => n.includes('marketing'));
  assert.ok(names.includes('request_marketing_spend'), names.join(','));
  assert.deepEqual(names.filter((n) => /approve|deny|paid|refund|mark_/.test(n)), [], 'no agent path approves or records money');

  // 1. 요청 단계 거부
  const noAllocation = await ask({ amount_minor: 10000 });
  assert.equal(noAllocation.isError, true);
  assert.match(JSON.stringify(noAllocation.error), /no approved budget allocation/);
  assert.ok((await audit()).some((e) => e.action === 'spend.refused'), 'refusals are audited');
  assert.equal(await ds.getRepository('MarketingSpendRequest').countBy({ campaign_id: campaign.id }), 0, 'refused requests are not stored');

  // 2. 편성
  const proposal = await mcp.callTool('propose_marketing_budget_allocation', {
    campaign_id: campaign.id, allocations: [{ channel_id: channel.id, amount_minor: 70000 }], rationale: 'Newsletter CTR was 4%.',
  });
  assert.equal(proposal.allocations[0].status, 'proposed', JSON.stringify(proposal));
  assert.equal((await post(`/allocations/${proposal.allocations[0].id}/approve`, M)).status, 403, 'manage cannot approve money');
  const tooBig = await post(`/allocations/${proposal.allocations[0].id}/approve`, A);
  assert.equal(tooBig.status, 409);
  assert.match(tooBig.body.error, /above the month cap/);
  const second = await mcp.callTool('propose_marketing_budget_allocation', {
    campaign_id: campaign.id, allocations: [{ channel_id: channel.id, amount_minor: 50000 }], rationale: 'Within the monthly cap.',
  });
  const allocations = (await api(`/campaigns/${campaign.id}/allocations`, A)).body;
  assert.equal(allocations.find((a) => a.id === proposal.allocations[0].id).status, 'superseded', 'an undecided earlier proposal is replaced');
  assert.equal((await post(`/allocations/${second.allocations[0].id}/approve`, A, { note: 'ok' })).body.status, 'active');

  for (const [fields, pattern] of [
    [{ amount_minor: 10000, payee: 'Attacker LLC' }, /allowlist/],
    [{ amount_minor: 10000, currency: 'USD' }, /currency USD/],
    [{ amount_minor: 60000 }, /per-transaction cap/],
    [{ amount_minor: 10.5 }, /integer|expected int/i],
    [{ amount_minor: 10000, expected_outcome: '' }, /expected_outcome/],
  ]) {
    const r = await ask(fields);
    assert.equal(r.isError, true, `${JSON.stringify(fields)} → ${JSON.stringify(r)}`);
    assert.match(JSON.stringify(r.error ?? r.raw ?? r), pattern, JSON.stringify(fields));
  }

  // 3. 승인
  const reqA = (await ask({ amount_minor: 15000, dedupe_key: 'slot-a', payload: { issue: 42, placement: 'top' } })).spend_request;
  assert.equal(reqA.status, 'pending');
  assert.match(reqA.payload_sha256, /^[0-9a-f]{64}$/);
  assert.equal(reqA.payee_ref, 'ads-acct-7');
  // 승인함 수 — 사람마다 자기가 처리할 수 있는 것만 센다. 돈 승인자는 manage 없이도 캠페인을 본다.
  const inboxOf = async (h) => (await api('/inbox', h)).body;
  assert.equal((await inboxOf(T)).total, 1, 'the treasurer sees the pending spend');
  assert.equal((await inboxOf(M)).total, 0, 'a manager without approve_spend has nothing to decide here');
  assert.equal((await inboxOf(A)).campaigns[0].spend_pending, 1);
  assert.equal((await api('/campaigns', T)).status, 200, 'approvers can read campaigns');
  assert.equal((await api(`/campaigns/${campaign.id}`, T)).status, 200);
  assert.equal((await api(`/campaigns/${campaign.id}/channels`, T)).status, 200);
  assert.equal((await post('/campaigns', T, { name: 'nope' })).status, 403, '… but cannot run campaigns');
  assert.equal((await post(`/channels/${channel.id}/pause`, T)).status, 403);
  const dup = await ask({ amount_minor: 15000, dedupe_key: 'slot-a' });
  assert.equal(dup.duplicate, true);
  assert.equal(dup.spend_request.id, reqA.id);
  assert.equal((await post(`/spend-requests/${reqA.id}/approve`, M, { payload_sha256: reqA.payload_sha256 })).status, 403);
  const wrongHash = await post(`/spend-requests/${reqA.id}/approve`, A, { payload_sha256: 'f'.repeat(64) });
  assert.equal(wrongHash.status, 409);
  assert.match(wrongHash.body.error, /payload_sha256/);
  const approvedA = await post(`/spend-requests/${reqA.id}/approve`, A, { payload_sha256: reqA.payload_sha256 });
  assert.equal(approvedA.status, 200, approvedA.text);
  assert.equal(approvedA.body.status, 'approved');
  assert.equal(approvedA.body.final, true);
  assert.equal(approvedA.body.decided_by, approverA.id);
  assert.equal((await budget()).total.held, 15000);

  const reqB = (await ask({ amount_minor: 25000 })).spend_request;
  const first = await post(`/spend-requests/${reqB.id}/approve`, A, { payload_sha256: reqB.payload_sha256 });
  assert.equal(first.body.final, false, 'at or above the threshold one approval is not enough');
  assert.equal(first.body.status, 'pending');
  assert.equal((await post(`/spend-requests/${reqB.id}/approve`, A, { payload_sha256: reqB.payload_sha256 })).status, 409, 'the same person cannot approve twice');
  const secondApproval = await post(`/spend-requests/${reqB.id}/approve`, B, { payload_sha256: reqB.payload_sha256 });
  assert.equal(secondApproval.body.status, 'approved');
  assert.deepEqual(secondApproval.body.approvals.map((a) => a.user_id), [approverA.id, approverB.id]);
  assert.equal((await budget()).total.held, 40000);
  const overChannel = await ask({ amount_minor: 15000 });
  assert.match(JSON.stringify(overChannel.error), /remaining allocation 10,000 KRW/);

  // 4. manual 결제 기록 · 실패 · 환불
  assert.equal((await post(`/spend-requests/${reqA.id}/mark-paid`, A, {})).status, 400, 'a transaction id is required');
  const paidA = await post(`/spend-requests/${reqA.id}/mark-paid`, A, { provider_ref: 'INV-2026-001', receipt_url: 'https://billing.example.com/inv/1' });
  assert.equal(paidA.body.status, 'paid', paidA.text);
  const failedB = await post(`/spend-requests/${reqB.id}/mark-failed`, A, { note: 'slot sold out' });
  assert.equal(failedB.body.status, 'failed');
  let summary = await budget();
  assert.deepEqual([summary.total.held, summary.total.spent], [0, 15000]);
  assert.equal((await post(`/spend-requests/${reqA.id}/refund`, A, { amount_minor: 20000, note: 'too much' })).status, 409);
  assert.equal((await post(`/spend-requests/${reqA.id}/refund`, A, { amount_minor: 5000 })).status, 400, 'a refund needs a reason');
  const refunded = await post(`/spend-requests/${reqA.id}/refund`, A, { amount_minor: 5000, note: 'partial make-good', provider_ref: 'CR-1' });
  assert.equal(refunded.body.status, 'paid', 'a refund does not reopen the request');
  summary = await budget();
  assert.equal(summary.total.spent, 10000);
  assert.equal(summary.channels[0].period_available_minor, 40000);
  const detail = await api(`/spend-requests/${reqA.id}`, A);
  assert.deepEqual(detail.body.ledger.map((e) => `${e.kind}:${e.amount_minor}`), ['reserve:15000', 'release:15000', 'capture:15000', 'refund:5000']);

  // 3b. 동시 승인 — 둘 다 요청 시점에는 들어가지만, 둘 다 승인되면 채널 편성(40,000)을 넘는다.
  const race1 = (await ask({ amount_minor: 19000 })).spend_request;
  const race2 = (await ask({ amount_minor: 19000 })).spend_request;
  const race3 = (await ask({ amount_minor: 19000 })).spend_request;
  const results = await Promise.all([race1, race2, race3].map((r) => post(`/spend-requests/${r.id}/approve`, A, { payload_sha256: r.payload_sha256 })));
  const won = results.filter((r) => r.status === 200);
  const lost = results.filter((r) => r.status === 409);
  assert.equal(won.length, 2, results.map((r) => `${r.status} ${r.text}`).join(' | '));
  assert.equal(lost.length, 1);
  assert.match(lost[0].body.error, /cannot approve/);
  summary = await budget();
  assert.equal(summary.total.held, 38000);
  assert.ok(summary.total.held + summary.total.spent <= 50000, 'never more than the channel allocation');
  for (const r of won) await post(`/spend-requests/${r.body.id}/mark-failed`, A, { note: 'cleanup' });
  const loser = [race1, race2, race3][results.findIndex((r) => r.status === 409)];
  assert.equal((await post(`/spend-requests/${loser.id}/deny`, A, { note: 'over budget' })).body.status, 'denied');

  // 2인 규칙은 요청 시점에 고정된다 — 요청 뒤에 임계값을 내려도 한 사람 승인으로 내려가지 않는다.
  const big = (await ask({ amount_minor: 25000 })).spend_request;
  assert.equal(big.dual_required, true);
  assert.equal((await patch(`/campaigns/${campaign.id}`, M, { dual_approval_threshold_minor: 0 })).status, 403, 'manage cannot touch the threshold');
  assert.equal((await patch(`/campaigns/${campaign.id}`, A, { dual_approval_threshold_minor: 0 })).status, 200);
  const stillTwo = await post(`/spend-requests/${big.id}/approve`, A, { payload_sha256: big.payload_sha256 });
  assert.equal(stillTwo.body.final, false, 'lowering the threshold later does not weaken a request already made');
  await post(`/spend-requests/${big.id}/deny`, A, { note: 'test' });
  assert.equal((await patch(`/campaigns/${campaign.id}`, A, { dual_approval_threshold_minor: 20000 })).status, 200);

  // 승인됐지만 아직 보내지 않은 요청은 취소할 수 있고, 보류한 예산이 풀린다.
  const later = (await ask({ amount_minor: 5000 })).spend_request;
  assert.equal((await post(`/spend-requests/${later.id}/approve`, A, { payload_sha256: later.payload_sha256 })).body.status, 'approved');
  assert.equal((await budget()).total.held, 5000);
  const cancelled = await post(`/spend-requests/${later.id}/cancel`, A, { note: 'changed plan' });
  assert.equal(cancelled.body.status, 'cancelled', cancelled.text);
  assert.equal((await budget()).total.held, 0, 'cancelling an approved request releases its reserve');

  // 재배분: 늘리는 쪽을 먼저 적어 보내도 줄이는 쪽부터 승인돼, 합이 정확히 상한(60,000)인 계획이 중간에 거부되지 않는다.
  const channel2 = (await post(`/campaigns/${campaign.id}/channels`, A, { platform: 'blog', target: 'https://devblog.example.net', name: 'Dev blog' })).body;
  await post(`/channels/${channel2.id}/approve`, A, { mode: 'manual' });
  const rebalance = await post(`/campaigns/${campaign.id}/allocations`, A, {
    allocations: [{ channel_id: channel2.id, amount_minor: 30000 }, { channel_id: channel.id, amount_minor: 30000 }],
    rationale: 'Move half of the budget to the blog.', approve: true,
  });
  assert.equal(rebalance.status, 201, rebalance.text);
  assert.deepEqual(rebalance.body.map((a) => a.status), ['active', 'active']);
  assert.equal((await budget()).allocated_total_minor, 60000);
  assert.equal((await post(`/campaigns/${campaign.id}/allocations`, M, { allocations: [{ channel_id: channel2.id, amount_minor: 1 }], rationale: 'x', approve: true })).status, 403,
    'setting budget is an approve_spend decision');

  // 5. webhook
  const credRepo = ds.getRepository('Credential');
  const payCred = await credRepo.save(credRepo.create({
    account_id: account.id, name: 'pay-hook', description: '', provider: 'custom',
    encrypted_data: encrypt(JSON.stringify({ webhook_url: payments.url, secret: WEBHOOK_SECRET })),
  }));
  assert.equal((await patch(`/campaigns/${campaign.id}`, M, { payment_provider: 'webhook', payment_credential_id: payCred.id })).status, 403,
    'payment settings need marketing.approve_spend');
  const setHook = await patch(`/campaigns/${campaign.id}`, A, { payment_provider: 'webhook', payment_credential_id: payCred.id });
  assert.equal(setHook.status, 200, setHook.text);

  const reqD = (await ask({ amount_minor: 5000, payload: { slot: 'D' } })).spend_request;
  assert.equal(reqD.provider, 'webhook');
  const paidD = await post(`/spend-requests/${reqD.id}/approve`, A, { payload_sha256: reqD.payload_sha256 });
  assert.equal(paidD.body.status, 'paid', paidD.text);
  assert.equal(paidD.body.provider_ref, 'txn_1');
  const sent = payments.seen[0];
  assert.equal(sent.valid, true, 'the request is HMAC-signed');
  assert.equal(sent.headers['idempotency-key'], reqD.id);
  assert.equal(sent.body.payload_sha256, reqD.payload_sha256);
  assert.equal(sent.body.amount_minor, 5000);
  assert.deepEqual(sent.body.payload, { slot: 'D' });
  assert.ok(!JSON.stringify(sent.body).includes(WEBHOOK_SECRET));

  payments.replies.push({ status: 503, body: { error: 'try later' } });
  const reqE = (await ask({ amount_minor: 4000 })).spend_request;
  const unknownE = await post(`/spend-requests/${reqE.id}/approve`, A, { payload_sha256: reqE.payload_sha256 });
  assert.equal(unknownE.body.status, 'unknown');
  assert.equal((await budget()).total.held, 4000, 'an ambiguous result keeps the money held');
  assert.equal(payments.seen.length, 2);
  await spendService.sweep(new Date(Date.now() + 60 * 60_000));
  assert.equal(payments.seen.length, 2, 'unknown is never re-sent automatically');
  const reconciled = await post(`/spend-requests/${reqE.id}/mark-paid`, A, { provider_ref: 'txn_checked_by_hand' });
  assert.equal(reconciled.body.status, 'paid');

  // 409(멱등 키 중복)는 "이미 처리됐을 수 있다" — failed 로 닫아 예산을 풀면 안 된다.
  payments.replies.push({ status: 409, body: { error: 'duplicate idempotency key' } });
  const dupKey = (await ask({ amount_minor: 2000 })).spend_request;
  const ambiguous = await post(`/spend-requests/${dupKey.id}/approve`, A, { payload_sha256: dupKey.payload_sha256 });
  assert.equal(ambiguous.body.status, 'unknown', '409 is ambiguous, not a refusal');
  await post(`/spend-requests/${dupKey.id}/mark-failed`, A, { note: 'checked: not charged' });

  payments.replies.push({ status: 402, body: { error: 'card declined' } });
  const reqF = (await ask({ amount_minor: 3000 })).spend_request;
  const failedF = await post(`/spend-requests/${reqF.id}/approve`, A, { payload_sha256: reqF.payload_sha256 });
  assert.equal(failedF.body.status, 'failed');
  assert.match(failedF.body.error, /402/);
  assert.equal((await post(`/spend-requests/${reqF.id}/mark-paid`, A, { provider_ref: 'x' })).status, 409);

  // 승인 직후 죽어 approved 로 남은 webhook 요청 — 그 사이 캠페인이 정지됐으면 sweep 이 보내지 않고 닫는다.
  const realExecute = spendService.execute;
  spendService.execute = async (id) => spendService.get(id, '');
  const stranded = (await ask({ amount_minor: 1500 })).spend_request;
  assert.equal((await post(`/spend-requests/${stranded.id}/approve`, A, { payload_sha256: stranded.payload_sha256 })).body.status, 'approved');
  spendService.execute = realExecute;
  await post(`/campaigns/${campaign.id}/status`, A, { status: 'paused' });
  const callsBefore = payments.seen.length;
  await spendService.sweep(new Date(Date.now() + 5 * 60_000));
  const strandedAfter = (await api(`/spend-requests/${stranded.id}`, A)).body;
  assert.equal(strandedAfter.status, 'failed');
  assert.match(strandedAfter.error, /not sent: the campaign is paused/);
  assert.equal(payments.seen.length, callsBefore, 'nothing was sent');
  assert.deepEqual(strandedAfter.ledger.map((e) => e.kind), ['reserve', 'release']);
  await post(`/campaigns/${campaign.id}/status`, A, { status: 'active' });

  // 실행 도중 재시작 → unknown(다시 보내지 않는다)
  const reqG = (await ask({ amount_minor: 1000 })).spend_request;
  await ds.getRepository('MarketingSpendRequest').update({ id: reqG.id }, { status: 'executing', executing_at: new Date(Date.now() - 60_000) });
  assert.equal(await spendService.recoverInterrupted(new Date()), 1);
  assert.equal((await api(`/spend-requests/${reqG.id}`, A)).body.status, 'unknown');
  assert.equal(payments.seen.length, 4, 'D, E, the 409 one and F were sent; G never was');

  // 6. 만료 · 일시정지 취소 · 통화 고정 · 삭제 불가
  const reqH = (await ask({ amount_minor: 1000 })).spend_request;
  await spendService.sweep(new Date(Date.now() + 73 * 60 * 60_000));
  assert.equal((await api(`/spend-requests/${reqH.id}`, A)).body.status, 'expired');
  assert.equal((await post(`/spend-requests/${reqH.id}/approve`, A, { payload_sha256: reqH.payload_sha256 })).status, 409);
  const reqI = (await ask({ amount_minor: 1000 })).spend_request;
  await post(`/campaigns/${campaign.id}/status`, A, { status: 'paused' });
  assert.equal((await api(`/spend-requests/${reqI.id}`, A)).body.status, 'cancelled', 'pausing the campaign cancels pending spend');
  const pausedAsk = await ask({ amount_minor: 1000 });
  assert.equal(pausedAsk.isError, true);
  assert.equal((await patch(`/campaigns/${campaign.id}`, A, { currency: 'USD' })).status, 409, 'currency is fixed once money moved');
  assert.equal((await api(`/campaigns/${campaign.id}`, A, { method: 'DELETE' })).status, 409, 'campaigns with money history are archived, not deleted');

  const actions = new Set((await audit()).map((e) => e.action));
  for (const a of ['allocation.proposed', 'allocation.approved', 'spend.requested', 'spend.first_approval', 'spend.approved', 'spend.paid', 'spend.failed',
    'spend.refunded', 'spend.executing', 'spend.unknown', 'spend.expired', 'spend.cancelled', 'spend.denied']) {
    assert.ok(actions.has(a), `audit has ${a}`);
  }
  const mcpView = await mcp.callTool('get_marketing_spend_request', { spend_request_id: reqD.id });
  assert.equal(mcpView.status, 'paid');
});
