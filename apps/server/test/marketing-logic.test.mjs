// Marketing 순수 규칙 — docs/marketing.md.
//
// 고정하는 것:
//   1. 금액은 정수 최소 단위만 받는다(부동소수 · 지수 표기 · 음수 · 안전 정수 밖 거부), 통화 지수와 표기.
//   2. 캠페인 입력 정규화: capability · 수취인 허용 목록 · 링크 허용 도메인 · 일일 상한 · cadence · 공개 문구.
//   3. 상태 전이 규칙(archived → active 는 한 번에 못 간다)과 다음 사이클 시각.
//
// 실행: node --test test/marketing-logic.test.mjs (dist 필요)

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMinorAmount, formatMinorAmount, currencyExponent, normalizeCurrency, MAX_MINOR_AMOUNT,
} from '../dist/common/marketing/money.js';
import {
  normalizeCapabilities, normalizePayees, findPayee, normalizeAllowedDomains, hostAllowed, normalizeLimits,
  resolveLimits, normalizeCadence, computeNextCycleAt, assertTransition, normalizeDisclosure, makeCampaignSlug,
} from '../dist/modules/marketing/marketing-campaign.logic.js';
import { DEFAULT_MARKETING_DISCLOSURE, DEFAULT_MARKETING_LIMITS } from '../dist/common/marketing/marketing-constants.js';

test('money: integer minor units only', () => {
  assert.equal(parseMinorAmount(50000, 'x'), 50000);
  assert.equal(parseMinorAmount('1250', 'x'), 1250);
  assert.equal(parseMinorAmount(0, 'x', { allowZero: true }), 0);
  for (const bad of [0, -1, 12.5, '12.5', '1e3', ' ', 'abc', null, undefined, Number.NaN, MAX_MINOR_AMOUNT + 1, '9007199254740993']) {
    assert.throws(() => parseMinorAmount(bad, 'amount'), /amount/, `rejects ${String(bad)}`);
  }
  assert.equal(currencyExponent('KRW'), 0);
  assert.equal(currencyExponent('jpy'), 0);
  assert.equal(currencyExponent('USD'), 2);
  assert.equal(currencyExponent('KWD'), 3);
  assert.equal(formatMinorAmount(50000, 'KRW'), '50,000 KRW');
  assert.equal(formatMinorAmount(123456, 'USD'), '1,234.56 USD');
  assert.equal(formatMinorAmount(5, 'USD'), '0.05 USD');
  assert.equal(formatMinorAmount(-1500, 'USD'), '-15.00 USD');
  assert.equal(normalizeCurrency(' usd '), 'USD');
  assert.throws(() => normalizeCurrency('US'), /ISO 4217/);
});

test('campaign input: capabilities, payees, domains, limits, disclosure', () => {
  assert.deepEqual(normalizeCapabilities(['email', 'analytics', 'email']), ['email', 'analytics']);
  assert.throws(() => normalizeCapabilities(['ads']), /unknown capability/);
  assert.throws(() => normalizeCapabilities('email'), /array/);

  const payees = normalizePayees([{ name: ' Reddit Ads ', ref: 'acct-1' }, 'Newsletter Co']);
  assert.deepEqual(payees, [{ name: 'Reddit Ads', ref: 'acct-1' }, { name: 'Newsletter Co' }]);
  assert.throws(() => normalizePayees([{ name: 'A' }, { name: 'a' }]), /duplicate payee/);
  assert.throws(() => normalizePayees([{ name: '' }]), /name is required/);
  assert.equal(findPayee({ payees }, 'reddit ads')?.ref, 'acct-1', 'payee match ignores case');
  assert.equal(findPayee({ payees }, 'Attacker LLC'), null);

  assert.deepEqual(normalizeAllowedDomains(['Example.com', 'https://docs.example.com/x', 'example.com']), ['example.com', 'docs.example.com']);
  for (const bad of ['localhost', 'http://', 'exa mple.com', '../etc', 'javascript:alert(1)']) {
    assert.throws(() => normalizeAllowedDomains([bad]), /allowed_domains/, `rejects ${bad}`);
  }
  assert.equal(hostAllowed('www.example.com', ['example.com']), true);
  assert.equal(hostAllowed('example.com', ['example.com']), true);
  assert.equal(hostAllowed('evil-example.com', ['example.com']), false, 'suffix must be a real subdomain');
  assert.equal(hostAllowed('example.com.evil.io', ['example.com']), false);

  assert.deepEqual(normalizeLimits({ drafts_per_day: 5 }), { drafts_per_day: 5 });
  assert.throws(() => normalizeLimits({ drafts_per_day: -1 }), /between 0/);
  assert.throws(() => normalizeLimits({ unknown_cap: 1 }), /unknown limit/);
  const limits = resolveLimits({ limits: { drafts_per_day: 5 } });
  assert.equal(limits.drafts_per_day, 5);
  assert.equal(limits.spend_requests_per_day, DEFAULT_MARKETING_LIMITS.spend_requests_per_day);

  assert.equal(normalizeDisclosure('   '), DEFAULT_MARKETING_DISCLOSURE, 'disclosure can never be empty');
  assert.equal(normalizeDisclosure('Made by the team'), 'Made by the team');
  assert.match(makeCampaignSlug('Launch Week! 2026', 'ab12'), /^launch-week-2026-ab12$/);
  assert.match(makeCampaignSlug('한국어 캠페인', 'ab12'), /^campaign-ab12$/);
});

test('cadence, next cycle and status transitions', () => {
  assert.deepEqual(normalizeCadence('0 1 * * *', undefined), { cron: '0 1 * * *', intervalMs: null });
  assert.deepEqual(normalizeCadence('', 3_600_000), { cron: null, intervalMs: 3_600_000 });
  assert.deepEqual(normalizeCadence(null, null), { cron: null, intervalMs: null }, 'manual cycles only');
  assert.throws(() => normalizeCadence('0 1 * * *', 3_600_000), /at most one/);
  assert.throws(() => normalizeCadence(null, 60_000), /10 minutes/);
  assert.throws(() => normalizeCadence('every day', null), /invalid cycle_cron/);

  const from = new Date('2026-10-22T00:30:00Z');
  assert.equal(computeNextCycleAt({ status: 'active', cycle_cron: '0 1 * * *', cycle_interval_ms: null }, from).toISOString(), '2026-10-22T01:00:00.000Z');
  assert.equal(computeNextCycleAt({ status: 'active', cycle_cron: null, cycle_interval_ms: 3_600_000 }, from).toISOString(), '2026-10-22T01:30:00.000Z');
  assert.equal(computeNextCycleAt({ status: 'paused', cycle_cron: '0 1 * * *', cycle_interval_ms: null }, from), null);

  assertTransition('draft', 'active');
  assertTransition('active', 'paused');
  assertTransition('paused', 'active');
  assertTransition('archived', 'paused');
  assert.throws(() => assertTransition('archived', 'active'), /cannot move/);
  assert.throws(() => assertTransition('active', 'draft'), /cannot move/);
});
