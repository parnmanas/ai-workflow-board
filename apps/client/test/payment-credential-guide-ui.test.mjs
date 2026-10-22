// Credentials 화면의 마케팅 결제 공급자 — 고르면 발급 방법이 사이트 안에 보인다(docs/marketing.md "직접 결제 어댑터" → "credential 발급").
//
// 고정하는 것:
//   1. 공급자 목록에 Meta Ads · Google Ads · Stripe Issuing 이 "Marketing payments" 묶음으로 있다.
//   2. 새 credential 에서 그 공급자를 고르면 발급 안내가 펼쳐져 보이고(순서 · 칸 · 자주 막히는 곳 · 공식 문서), 입력 칸은 그 공급자의 필드다.
//   3. 다른 공급자를 고르면 안내가 사라진다.
//
// 실행: node --import tsx --test test/payment-credential-guide-ui.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, click, React, act, run } from './helpers/jsdom.mjs';
import { installFakeEventSource, mountWithBoardStream } from './helpers/boardStream.mjs';
import { api } from '../src/api.ts';
import CredentialManager from '../src/components/admin/CredentialManager.tsx';

async function mountManager(t) {
  const dom = setupDom();
  globalThis.localStorage = dom.window.localStorage;
  globalThis.sessionStorage = dom.window.sessionStorage;
  const { uninstall } = installFakeEventSource();
  localStorage.setItem('auth_token', 'admin-session');
  const originals = { getMe: api.getMe, getSetupStatus: api.getSetupStatus, listCredentials: api.listCredentials };
  api.getMe = async () => ({
    id: 'admin-1', name: 'Admin', email: 'admin@example.test', role: 'admin', status: 'active',
    permissions: [], accounts: [{ id: 'account-1', name: 'Account One', slug: null, relations: [] }],
  });
  api.getSetupStatus = async () => ({ needs_setup: false });
  api.listCredentials = async () => [];
  const view = mountWithBoardStream(React.createElement(CredentialManager, { createAccountId: 'account-1' }));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  t.after(() => { view.unmount(); uninstall(); Object.assign(api, originals); dom.cleanup(); });
  return view;
}

function providerSelect() {
  const select = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'github'));
  assert.ok(select, 'provider select');
  return select;
}

function choose(select, value) {
  run(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(select), 'value')?.set;
    setter.call(select, value);
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

test('choosing a marketing payment provider shows how to get its credential, in the site', async (t) => {
  const { container } = await mountManager(t);
  const create = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === '+ New Credential');
  assert.ok(create);
  click(create);
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

  const select = providerSelect();
  const group = [...select.querySelectorAll('optgroup')].find((g) => g.label === 'Marketing payments (server only)');
  assert.ok(group, 'the payment providers are grouped');
  assert.deepEqual([...group.querySelectorAll('option')].map((o) => o.value), ['meta_ads', 'google_ads', 'stripe_issuing']);

  choose(select, 'stripe_issuing');
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const guide = document.querySelector('[data-testid="payment-credential-guide-stripe_issuing"]');
  assert.ok(guide, 'the Stripe guide is shown');
  assert.equal(guide.open, true, 'open by default for a new credential');
  assert.match(guide.textContent, /Create restricted key/);
  assert.match(guide.textContent, /issuing_card_write · issuing_cardholder_read/);
  assert.match(guide.textContent, /secret_key — 제한된 API 키/);
  assert.ok([...guide.querySelectorAll('a')].some((a) => a.getAttribute('href') === 'https://docs.stripe.com/keys/restricted-api-keys'));
  assert.match(document.body.textContent, /Restricted API key/, 'the form asks for the Stripe key');

  choose(select, 'google_ads');
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const google = document.querySelector('[data-testid="payment-credential-guide-google_ads"]');
  assert.ok(google);
  assert.match(google.textContent, /gcloud auth application-default login/);
  assert.equal(Boolean(document.querySelector('[data-testid="payment-credential-guide-stripe_issuing"]')), false);

  choose(select, 'github');
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  assert.equal(Boolean(document.querySelector('[data-testid^="payment-credential-guide-"]')), false, 'no guide for other providers');
});
