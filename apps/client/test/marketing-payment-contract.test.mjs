// 직접 결제 어댑터(docs/marketing.md "직접 결제 어댑터")의 화면 규칙과 서버 정본(apps/server/src/common/marketing/payment-routes.ts)의
// 대조, 그리고 화면 쪽 순수 판정.
//
// 고정하는 것:
//   1. 공급자 목록 · ref 형식 문구 · credential 필드가 서버와 같다. Credentials 화면의 전용 입력 칸(meta_ads · google_ads)도 그
//      필드 그대로이고, 에이전트 노출을 고를 수 없다.
//   2. ref 형식 판정이 서버 파서와 같은 답을 낸다(같은 표본).
//   3. credential 후보는 그 공급자로 만든 이 계정의 것만(전역 · 다른 종류 · 에이전트 노출 제외).
//   4. 상한 공급자의 paid 는 "한도 반영됨", 환불 기록 불가. 승인 · 대조 안내는 공급자마다 다르다. 공급자 확인 한 줄.
//   5. 결과 불명의 실패 기록 유예(DIRECT_FAIL_GRACE_MS)가 서버와 같고, 대조 안내가 그 시각을 알린다. 다른 계정의 열린 요청은 id 없이 표시한다.
//
// 실행: node --import tsx --test test/marketing-payment-contract.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DIRECT_FAIL_GRACE_MS, DIRECT_PAYMENT_PROVIDERS, DIRECT_PAYMENT_PROVIDER_LABELS, DIRECT_REF_FORMATS, DIRECT_PROVIDER_CREDENTIAL_FIELDS, PAYMENT_PROVIDER_LABELS,
  canRecordRefund, directPaymentCredentials, directRefProblem, formatDateTime, inspectionSummary, isDirectPaymentProvider, openRequestLabel,
  payeeRouteLabel, spendApproveHint, spendStatusViewFor, unknownReconcileHint,
} from '../src/components/marketing/marketing.logic.ts';
import { AGENT_ENV_PROVIDERS } from '../src/components/admin/credentialAgentEnv.logic.ts';

const SERVER_RULES = new URL('../../server/src/common/marketing/payment-routes.ts', import.meta.url);
const CREDENTIAL_MANAGER = new URL('../src/components/admin/CredentialManager.tsx', import.meta.url);

test('the screen mirrors the server: providers, ref formats, credential fields', async () => {
  const server = await import(SERVER_RULES.href);
  assert.deepEqual([...DIRECT_PAYMENT_PROVIDERS], [...server.DIRECT_PAYMENT_PROVIDERS]);
  assert.deepEqual(DIRECT_PAYMENT_PROVIDER_LABELS, server.DIRECT_PAYMENT_PROVIDER_LABELS);
  assert.deepEqual(DIRECT_REF_FORMATS, server.DIRECT_REF_FORMATS);
  assert.deepEqual(JSON.parse(JSON.stringify(DIRECT_PROVIDER_CREDENTIAL_FIELDS)), JSON.parse(JSON.stringify(server.DIRECT_PROVIDER_CREDENTIAL_FIELDS)));
  assert.equal(DIRECT_FAIL_GRACE_MS, server.DIRECT_FAIL_GRACE_MS, 'the reconcile hint tells the same wait the server enforces');
  for (const p of DIRECT_PAYMENT_PROVIDERS) assert.ok(PAYMENT_PROVIDER_LABELS[p], `label for ${p}`);

  // 같은 표본에 서버 파서와 같은 답
  const samples = {
    meta_ads: ['act_123/456', ' act_123 / 456 ', '123/456', 'act_12a/4', 'act_1', 'act_1/2/3', ''],
    google_ads: ['123-456-7890/99', '1234567890/99', '123456789/9', '12345678901/9', 'abc/9', '1234567890'],
  };
  for (const [provider, refs] of Object.entries(samples)) {
    for (const ref of refs) {
      let serverOk = true;
      try { server.canonicalDirectRef(provider, ref); } catch { serverOk = false; }
      assert.equal(directRefProblem(provider, ref) === '', serverOk, `${provider} ${JSON.stringify(ref)}`);
    }
  }
});

test('the Credentials screen has typed, server-only entries for the payment providers', () => {
  const source = fs.readFileSync(CREDENTIAL_MANAGER, 'utf8');
  for (const provider of DIRECT_PAYMENT_PROVIDERS) {
    const start = source.indexOf(`value: '${provider}'`);
    assert.ok(start > 0, `CredentialManager offers ${provider}`);
    const block = source.slice(start, source.indexOf('},\n  },', start));
    const fields = [...block.matchAll(/^\s{6}([a-z_]+): \{ label:/gm)].map((m) => m[1]);
    const expected = [...DIRECT_PROVIDER_CREDENTIAL_FIELDS[provider].required, ...DIRECT_PROVIDER_CREDENTIAL_FIELDS[provider].optional];
    assert.deepEqual(fields, expected, `${provider} fields`);
    assert.equal(AGENT_ENV_PROVIDERS.has(provider), false, `${provider} can never be exposed to agents`);
  }
});

test('credential candidates: this account, this provider, never global or agent-exposed', () => {
  const cred = (id, over = {}) => ({ id, name: id, provider: 'meta_ads', account_id: 'acc-1', agent_env: false, ...over });
  const all = [
    cred('ok'),
    cred('global', { account_id: null }),
    cred('other-account', { account_id: 'acc-2' }),
    cred('exposed', { agent_env: true }),
    cred('custom', { provider: 'custom' }),
    cred('google', { provider: 'google_ads' }),
  ];
  assert.deepEqual(directPaymentCredentials(all, 'meta_ads', 'acc-1').map((c) => c.id), ['ok']);
  assert.deepEqual(directPaymentCredentials(all, 'google_ads', 'acc-1').map((c) => c.id), ['google']);
});

test('ceiling providers read differently: status, refund, approval and reconcile hints, inspection', () => {
  assert.equal(isDirectPaymentProvider('meta_ads'), true);
  assert.equal(isDirectPaymentProvider('webhook'), false);
  assert.equal(payeeRouteLabel({ name: 'M', provider: 'meta_ads', credential_id: 'c', ref: 'act_9/77' }), 'Meta Ads · act_9/77');
  assert.equal(payeeRouteLabel({ name: 'N', ref: 'inv' }), '');
  assert.equal(spendStatusViewFor({ status: 'paid', provider: 'meta_ads' }).label, '한도 반영됨');
  assert.equal(spendStatusViewFor({ status: 'paid', provider: 'manual' }).label, '결제 완료');
  assert.equal(spendStatusViewFor({ status: 'unknown', provider: 'google_ads' }).label, '결과 불명 — 확인 필요');
  assert.equal(canRecordRefund({ status: 'paid', provider: 'manual' }), true);
  assert.equal(canRecordRefund({ status: 'paid', provider: 'google_ads' }), false, 'lowering the ceiling comes first');
  assert.match(spendApproveHint({ provider: 'meta_ads' }), /spend_cap/);
  assert.match(spendApproveHint({ provider: 'google_ads' }), /총예산/);
  assert.match(spendApproveHint({ provider: 'webhook' }), /결제 엔드포인트/);
  assert.match(spendApproveHint({ provider: 'manual' }), /AWB 밖에서 결제한 뒤/);
  const metaHint = unknownReconcileHint({ provider: 'meta_ads', currency: 'USD', payload: { target: { campaign_id: '77' }, from: '100000', to: '130000', from_minor: 100000, to_minor: 130000 } });
  assert.match(metaHint, /캠페인 77 의 지출 한도가 1,300\.00 USD\(목표\)인지 1,000\.00 USD\(이전\)인지/, 'currency, not provider units');
  assert.match(metaHint, /실행 뒤 15분이 지나야 실패로 기록할 수 있습니다/);
  const executingAt = '2026-10-22T06:00:00.000Z';
  const timed = unknownReconcileHint({ provider: 'meta_ads', currency: 'USD', executing_at: executingAt, payload: { target: { campaign_id: '77' }, from_minor: 100000, to_minor: 130000 } });
  const failAt = formatDateTime(new Date(Date.parse(executingAt) + DIRECT_FAIL_GRACE_MS).toISOString());
  assert.ok(timed.includes(`실행 뒤 15분(${failAt})이 지나야 실패로 기록할 수 있습니다`), timed);
  assert.match(unknownReconcileHint({ provider: 'google_ads', currency: 'KRW', payload: { target: { campaign_id: '5' }, from_minor: 500000, to_minor: 700000 } }), /총예산이 700,000 KRW\(목표\)인지/);
  assert.match(unknownReconcileHint({ provider: 'webhook', currency: 'USD', payload: {} }), /결제 시스템에서/);
  assert.equal(openRequestLabel(null), '');
  assert.equal(openRequestLabel({ id: 'sp-1', status: 'pending' }), '열린 요청 pending');
  assert.equal(openRequestLabel({ id: '', status: 'other_account' }), '다른 계정에 열린 요청 있음', 'no id or state from another account');
  const insp = { from_minor: 100000, to_minor: 130000, observed: '130000', observed_minor: 130000, position: 'at_target' };
  assert.equal(inspectionSummary(insp, 'USD'), '지금 상한 1,300.00 USD: 목표값입니다 — 반영된 것으로 보입니다. (1,000.00 USD → 1,300.00 USD 계획)');
  assert.match(inspectionSummary({ ...insp, observed: '100000', observed_minor: 100000, position: 'at_from' }, 'USD'), /반영되지 않은 것으로/);
  assert.match(inspectionSummary({ ...insp, observed: null, observed_minor: null, position: 'no_ceiling' }, 'USD'), /^지금 상한 한도 없음: 한도가 없습니다/);
});
