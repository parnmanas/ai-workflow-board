// Marketing 예산 계산 — 순수 함수(docs/marketing.md "원장 계산").
//
// 고정하는 것:
//   1. 예산 기간 키(UTC 월 · ISO 주 · none)와 경계.
//   2. 원장 합: held = reserve − release, spent = capture − refund. 원장 행은 승인된 기간에 묶인다 —
//      다음 달에 결제 · 환불돼도 승인한 달의 사용량이다.
//   3. 한도 위반 사유: 통화 · 총 예산 0 · 건당 상한 · 총 가용 · 기간 가용 · 채널 편성 없음 · 채널 편성 초과.
//   4. 정규화 JSON 과 payload 해시 — 키 순서와 무관하고, 금액 · 수취인 · payload 가 바뀌면 달라진다.
//   5. webhook 서명 형식과 결과 분류(2xx+txn → paid, 4xx → failed, 그 밖 → unknown, 리다이렉트 안 따라감).
//
// 실행: node --test test/marketing-budget-logic.test.mjs (dist 필요)

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  periodKey, periodBounds, usageOf, budgetSnapshot, spendViolations, canonicalJson, spendPayloadHash,
} from '../dist/common/marketing/budget.js';
import { executeWebhookPayment, signWebhookBody, validateWebhookUrl, readWebhookSecret } from '../dist/modules/marketing/marketing-payments.js';

test('period keys and bounds (UTC)', () => {
  assert.equal(periodKey('month', new Date('2026-10-31T23:59:59Z')), '2026-10');
  assert.equal(periodKey('month', new Date('2026-11-01T00:00:00Z')), '2026-11');
  assert.equal(periodKey('week', new Date('2026-10-22T12:00:00Z')), '2026-W43');
  assert.equal(periodKey('week', new Date('2027-01-01T00:00:00Z')), '2026-W53', 'ISO week year');
  assert.equal(periodKey('none', new Date()), 'all');
  const month = periodBounds('month', new Date('2026-10-22T12:00:00Z'));
  assert.equal(month.start.toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(month.end.toISOString(), '2026-11-01T00:00:00.000Z');
  const week = periodBounds('week', new Date('2026-10-22T12:00:00Z'));
  assert.equal(week.start.toISOString(), '2026-10-19T00:00:00.000Z', 'weeks start on Monday');
  assert.equal(periodBounds('none', new Date()), null);
});

const caps = { currency: 'KRW', budget_total_minor: 100000, budget_period: 'month', budget_period_minor: 60000, max_transaction_minor: 50000 };
const row = (kind, amount, period_key = '2026-10', channel_id = 'ch1', spend_request_id = 'r1') => ({ kind, amount_minor: amount, period_key, channel_id, spend_request_id });

test('ledger usage and period attribution', () => {
  const rows = [
    row('reserve', 30000, '2026-10', 'ch1', 'a'),
    row('release', 30000, '2026-10', 'ch1', 'a'),
    row('capture', 30000, '2026-10', 'ch1', 'a'), // 11월에 결제됐어도 10월 승인분
    row('refund', 5000, '2026-10', 'ch1', 'a'),
    row('reserve', 20000, '2026-10', 'ch2', 'b'),
  ];
  assert.deepEqual(usageOf(rows), { held: 20000, spent: 25000 });
  const nov = budgetSnapshot(caps, rows, new Date('2026-11-05T00:00:00Z'), { id: 'ch1', allocation_minor: 40000 });
  assert.equal(nov.period_key, '2026-11');
  assert.deepEqual([nov.period.held, nov.period.spent, nov.period.available], [0, 0, 60000], 'October approvals do not eat November');
  assert.equal(nov.total.available, 100000 - 25000 - 20000);
  assert.equal(nov.channel.available, 40000);
  const oct = budgetSnapshot(caps, rows, new Date('2026-10-20T00:00:00Z'), { id: 'ch1', allocation_minor: 40000 });
  assert.equal(oct.period.available, 60000 - 45000);
  assert.equal(oct.channel.available, 40000 - 25000);
  assert.equal(budgetSnapshot({ ...caps, budget_period: 'none' }, rows, new Date()).period.cap, null);
});

test('spend violations name every broken limit', () => {
  const now = new Date('2026-10-20T00:00:00Z');
  const rows = [row('reserve', 40000, '2026-10', 'ch1')];
  assert.deepEqual(spendViolations(caps, rows, now, { amount_minor: 5000, currency: 'KRW', channel_id: 'ch1' }, 50000), []);
  const v = (amount, alloc = 50000, extra = {}) => spendViolations({ ...caps, ...extra }, rows, now, { amount_minor: amount, currency: 'KRW', channel_id: 'ch1' }, alloc).join(' | ');
  assert.match(v(60000), /per-transaction cap 50,000 KRW/);
  assert.match(v(25000), /remaining monthly budget|remaining month budget/);
  assert.match(v(15000), /channel's remaining allocation 10,000 KRW/);
  assert.match(v(1000, null), /no approved budget allocation/);
  assert.match(v(1000, 50000, { budget_total_minor: 0 }), /no budget/);
  assert.match(spendViolations(caps, rows, now, { amount_minor: 1, currency: 'USD', channel_id: 'ch1' }, 50000).join(), /currency USD/);
});

test('canonical JSON and payload hash', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}');
  const base = {
    campaign_id: 'c', channel_id: 'ch', amount_minor: 5000, currency: 'KRW', payee: 'Ads Co', payee_ref: 'acct',
    purpose: 'boost', provider: 'webhook', provider_credential_id: 'cred', payload: { b: 2, a: 1 },
  };
  const h = spendPayloadHash(base);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(spendPayloadHash({ ...base, payload: { a: 1, b: 2 } }), h, 'key order does not matter');
  for (const change of [{ amount_minor: 5001 }, { payee: 'Other' }, { payload: { a: 1, b: 3 } }, { provider: 'manual' }, { channel_id: 'x' }]) {
    assert.notEqual(spendPayloadHash({ ...base, ...change }), h, `hash covers ${Object.keys(change)[0]}`);
  }
});

test('webhook adapter: url policy, signature, outcome classification', async () => {
  assert.equal(validateWebhookUrl('https://pay.example.com/hook'), 'https://pay.example.com/hook');
  assert.equal(validateWebhookUrl('http://127.0.0.1:9999/x'), 'http://127.0.0.1:9999/x');
  assert.throws(() => validateWebhookUrl('http://pay.example.com/hook'), /https/);
  assert.throws(() => validateWebhookUrl('https://user:pw@pay.example.com/'), /credentials/);
  assert.throws(() => readWebhookSecret({ webhook_url: 'https://x.example.com', secret: 'short' }), /16/);

  const sig = signWebhookBody('0123456789abcdef', '{"a":1}', 1700000000);
  assert.equal(sig, `t=1700000000,v1=${createHmac('sha256', '0123456789abcdef').update('1700000000.{"a":1}').digest('hex')}`);

  const secret = { webhook_url: 'https://pay.example.com/hook', secret: '0123456789abcdef' };
  const seen = [];
  const fake = (status, body) => async (url, init) => {
    seen.push({ url, init });
    return new Response(body, { status });
  };
  const paid = await executeWebhookPayment({ secret, body: '{}', idempotencyKey: 'req-1', fetchImpl: fake(200, '{"transaction_id":"txn_9","receipt_url":"https://r.example.com/9"}') });
  assert.equal(paid.outcome, 'paid');
  assert.equal(paid.transaction_id, 'txn_9');
  assert.equal(seen[0].init.headers['idempotency-key'], 'req-1');
  assert.equal(seen[0].init.redirect, 'manual', 'redirects are not followed');
  assert.match(seen[0].init.headers['x-awb-signature'], /^t=\d+,v1=[0-9a-f]{64}$/);
  assert.equal((await executeWebhookPayment({ secret, body: '{}', idempotencyKey: 'k', fetchImpl: fake(200, '{"ok":true}') })).outcome, 'unknown', '2xx without txn is ambiguous');
  assert.equal((await executeWebhookPayment({ secret, body: '{}', idempotencyKey: 'k', fetchImpl: fake(402, 'declined') })).outcome, 'failed');
  assert.equal((await executeWebhookPayment({ secret, body: '{}', idempotencyKey: 'k', fetchImpl: fake(503, 'later') })).outcome, 'unknown');
  assert.equal((await executeWebhookPayment({ secret, body: '{}', idempotencyKey: 'k', fetchImpl: fake(302, '') })).outcome, 'unknown');
  const thrown = await executeWebhookPayment({ secret, body: '{}', idempotencyKey: 'k', fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  assert.equal(thrown.outcome, 'unknown', 'network errors never close a payment as failed');
  const slow = await executeWebhookPayment({
    secret, body: '{}', idempotencyKey: 'k', timeoutMs: 20,
    fetchImpl: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
  });
  assert.equal(slow.outcome, 'unknown');
  assert.match(slow.error, /timed out/);
});
