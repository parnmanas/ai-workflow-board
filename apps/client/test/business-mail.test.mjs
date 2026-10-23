import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, mount, click, typeInto, run, React, act } from './helpers/jsdom.mjs';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { api } from '../src/api.ts';
import { AuthProvider } from '../src/contexts/AuthContext.tsx';
import { ToastProvider } from '../src/contexts/ToastContext.tsx';
import BusinessMailPage from '../src/components/business/BusinessMailPage.tsx';
import BusinessLayout from '../src/components/business/BusinessLayout.tsx';

const h = React.createElement;
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const button = (container, label) => { const node = [...container.querySelectorAll('button')].find(b => b.textContent.trim() === label); if (!node) throw new Error(`Missing button ${label}`); return node; };
const connection = { id: 'c1', account_id: 'a1', company_id: null, name: 'Operations NAS', purpose: 'operations', provider: 'smtp_imap', credential_id: 'key', revision: 0, enabled: true, interval_minutes: 5, status: 'connected', synced_at: '', last_error: '', busy: false, config: { addresses: ['ops@example.com'], smtp: { host: 'smtp.example.com', port: 587, tls: 'starttls', username: 'ops' }, imap: { host: 'imap.example.com', port: 993, tls: 'implicit', username: 'ops', folder: 'INBOX' } } };
const message = { id: 'm1', connection_id: 'c1', direction: 'inbound', status: 'received', from: 'vendor@example.com', to: ['ops@example.com'], subject: 'Invoice', preview: 'Private mail', text: '<img src="https://tracker.example.com/x">Untrusted message', date: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z', confirmed: false, note: '', revision: 0, attachments: [], last_error: '' };
async function render(t, { entry = '/business/mail', permissions = ['business.manage'], stubs = {} } = {}) {
  const dom = setupDom(); globalThis.localStorage = dom.window.localStorage; globalThis.sessionStorage = dom.window.sessionStorage;
  globalThis.Audio = class { play() { return Promise.resolve(); } pause() {} };
  localStorage.setItem('auth_token', 'test');
  const calls = []; const original = {};
  for (const [key, fn] of Object.entries({
    getMe: async () => ({ id: 'u1', name: 'Owner', status: 'active', resolved_permissions: permissions, accounts: [{ id: 'a1', name: 'Personal' }] }),
    listBusinessCompanies: async () => [{ id: 'co1', account_id: 'a1', name: 'Company One' }],
    listBusinessMailConnections: async () => ({ connectors: [{ id: 'smtp_imap', name: 'SMTP · IMAP', note: 'Application passwords' }, { id: 'jmap', name: 'JMAP', note: 'API token' }], connections: [connection, { ...connection, id: 'c2', account_id: 'a2', name: 'Accounting', purpose: 'accounting' }], credentials: [{ id: 'key', name: 'Mail key', account_id: 'a1' }] }),
    listBusinessMail: async () => ({ messages: [message], total: 1, offset: 0, limit: 50 }),
    getBusinessMail: async () => ({ ...message }),
    confirmBusinessMail: async (_id, input) => ({ ...message, ...input, revision: 1, confirmed_at: new Date().toISOString() }),
    configureBusinessMail: async input => ({ ...input, id: 'c1' }),
    ...stubs,
  })) { original[key] = api[key]; api[key] = async (...args) => { calls.push([key, ...args]); return fn(...args); }; }
  const view = mount(h(MemoryRouter, { initialEntries: [entry] }, h(ToastProvider, null, h(AuthProvider, null,
    h(Routes, null, h(Route, { element: h(BusinessLayout) }, h(Route, { path: '/business/mail', element: h(BusinessMailPage) })))))));
  t.after(() => { view.unmount(); Object.assign(api, original); dom.cleanup(); });
  await flush(); await flush(); await flush();
  return { ...view, calls };
}

test('Business mail opens a unified list and preserves other filters while selecting a company or purpose', async t => {
  const { container, calls } = await render(t);
  assert.equal(Boolean(container.querySelector('.business-company-picker')), false);
  assert.match(container.textContent, /비즈니스 메일/);
  assert.deepEqual(calls.find(c => c[0] === 'listBusinessMail')[1], {});
  const company = container.querySelector('[aria-label="모든 회사"]');
  run(() => { company.value = 'co1'; company.dispatchEvent(new window.Event('change', { bubbles: true })); }); await flush(); await flush();
  const purpose = container.querySelector('[aria-label="모든 업무 용도"]');
  run(() => { purpose.value = 'accounting'; purpose.dispatchEvent(new window.Event('change', { bubbles: true })); }); await flush(); await flush();
  assert.deepEqual(calls.filter(c => c[0] === 'listBusinessMail').at(-1)[1], { company_id: 'co1', purpose: 'accounting' });
  click(button(container, '필터 초기화')); await flush(); await flush();
  assert.deepEqual(calls.filter(c => c[0] === 'listBusinessMail').at(-1)[1], {});
});

test('reading mail renders text safely and does not confirm until the processing action is clicked', async t => {
  const { container, calls } = await render(t);
  click(container.querySelector('.business-mail-row')); await flush(); await flush();
  assert.equal(calls.some(c => c[0] === 'confirmBusinessMail'), false);
  assert.equal(container.querySelectorAll('.business-mail-body img').length, 0);
  assert.match(container.querySelector('.business-mail-body').textContent, /Untrusted message/);
  typeInto(container.querySelector('textarea'), 'Invoice recorded');
  click(button(container, '확인 완료')); await flush(); await flush();
  assert.deepEqual(calls.find(c => c[0] === 'confirmBusinessMail').slice(1), ['m1', { revision: 0, confirmed: true, note: 'Invoice recorded' }]);
  assert.match(container.textContent, /미확인으로 되돌리기/);
});

test('connection settings preserve the cursor-bound server and let the user pause collection', async t => {
  const { container, calls } = await render(t, { entry: '/business/mail?connections=1' });
  click(button(container, '설정')); await flush();
  const dialog = container.querySelector('[role="dialog"]');
  assert.equal(Boolean(dialog), true);
  assert.equal([...dialog.querySelectorAll('input')].find(n => n.value === 'imap.example.com').disabled, true);
  const enabled = [...dialog.querySelectorAll('input[type="checkbox"]')].at(-1);
  click(enabled); click(button(container, '연결 저장')); await flush(); await flush();
  const saved = calls.find(c => c[0] === 'configureBusinessMail')[1]; assert.equal(saved.enabled, false); assert.equal(saved.id, 'c1'); assert.equal(saved.revision, 0);
});

test('missing business permission does not fetch private mail', async t => {
  const { container, calls } = await render(t, { permissions: [] });
  assert.match(container.textContent, /business.manage 권한/);
  assert.equal(calls.some(c => c[0] === 'listBusinessMail'), false);
});
