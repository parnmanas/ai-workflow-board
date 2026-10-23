import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, mount, click, typeInto, run, React, act } from './helpers/jsdom.mjs';
import { MemoryRouter, Routes, Route, useSearchParams } from 'react-router-dom';
import { api } from '../src/api.ts';
import { AuthProvider } from '../src/contexts/AuthContext.tsx';
import { ToastProvider } from '../src/contexts/ToastContext.tsx';
import BusinessPage from '../src/components/business/BusinessPage.tsx';
import BusinessLayout from '../src/components/business/BusinessLayout.tsx';
import { money, nextTasks, overdue } from '../src/components/business/business.logic.ts';

const h = React.createElement;
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const company = { id: 'company-1', account_id: 'account-1', name: 'Example LLC', entity_type: 'LLC', country: 'US', jurisdiction: 'DE', description: 'Build useful things', campaign_ids: [], revision: 0 };
const task = (patch = {}) => ({ id: 'task-1', account_id: 'account-1', company_id: company.id, title: '설립 계획 정하기', stage: 'formation', status: 'todo', description: '', owner: '', notes: '', due_on: null, depends_on: [], blocked_by: [], ticket_id: null, ticket: null, position: 0, ...patch });
const detail = (patch = {}) => ({ company: { ...company }, tasks: [task(), task({ id: 'task-2', title: '설립 신청', position: 1, depends_on: ['task-1'], blocked_by: ['task-1'] })], connections: [], events: [], campaigns: [], ...patch });
const connector = { id: 'stripe', name: 'Stripe', stage: 'payments', color: '#a5b4fc', monogram: 'S', mode: 'api', summary: '결제 잔액과 정산 거래', capabilities: ['잔액 조회'], setup_note: '조회용 키를 연결하세요.', docs_url: 'https://docs.stripe.com/api/balance', portal_url: 'https://dashboard.stripe.com', credential_provider: 'stripe', secret_fields: ['secret_key'], fields: [], environments: ['sandbox', 'live'] };
function TicketRoute() { const [params] = useSearchParams(); return h('div', null, `Execution ticket ${params.get('ticket')}`); }

async function render(t, { entry = '/business', permissions = ['business.manage'], stubs = {} } = {}) {
  const dom = setupDom();
  globalThis.localStorage = dom.window.localStorage;
  globalThis.sessionStorage = dom.window.sessionStorage;
  globalThis.Audio = class { play() { return Promise.resolve(); } pause() {} };
  localStorage.setItem('auth_token', 'test-token');
  const calls = [];
  const original = {};
  for (const [key, fn] of Object.entries({
    getMe: async () => ({ id: 'u1', name: 'Owner', status: 'active', resolved_permissions: permissions, accounts: [{ id: 'account-1', name: 'Personal' }] }),
    listBusinessCompanies: async () => [{ ...company }], listBusinessConnectors: async () => [connector], getBusinessCompany: async () => detail(),
    listBusinessCredentials: async () => [{ id: 'cred-1', name: 'Stripe read key', provider: 'stripe' }], ...stubs,
  })) {
    original[key] = api[key]; api[key] = async (...args) => { calls.push([key, ...args]); return fn(...args); };
  }
  const view = mount(h(MemoryRouter, { initialEntries: [entry] }, h(ToastProvider, null, h(AuthProvider, null,
    h(Routes, null, h(Route, { element: h(BusinessLayout) },
      h(Route, { path: '/business', element: h(BusinessPage, { view: 'overview' }) }),
      h(Route, { path: '/business/operations', element: h(BusinessPage, { view: 'operations' }) }),
      h(Route, { path: '/business/connectors', element: h(BusinessPage, { view: 'connectors' }) }),
      h(Route, { path: '/marketing', element: h('div', null, 'Existing Marketing') })),
      h(Route, { path: '/tickets', element: h(TicketRoute) }))))));
  t.after(() => { view.unmount(); Object.assign(api, original); dom.cleanup(); });
  await flush(); await flush(); await flush();
  return { ...view, calls };
}
function button(root, label) {
  const element = [...root.querySelectorAll('button')].find(b => b.textContent.includes(label));
  assert.ok(element, `button ${label} exists`); return element;
}
function field(root, label) {
  const element = root.querySelector(`[aria-label="${label}"]`);
  assert.ok(element, `field ${label} exists`); return element;
}

test('without business permission the page makes no business requests, and marketing navigation remains usable', async t => {
  const { container, calls } = await render(t, { permissions: ['marketing.manage'] });
  assert.match(container.textContent, /Business 권한이 필요/);
  assert.equal(calls.some(([name]) => name.startsWith('listBusiness') || name === 'getBusinessCompany'), false);
  const link = container.querySelector('a[href="/marketing"]'); assert.ok(link); click(link);
  await flush();
  assert.match(container.textContent, /Existing Marketing/);
});

test('empty state creates a persistent workflow and opens the new company without inventing metrics', async t => {
  let created = false;
  let saved;
  const { container } = await render(t, { stubs: {
    listBusinessCompanies: async () => created ? [{ ...company, name: saved.name }] : [],
    createBusinessCompany: async input => { saved = input; created = true; return { ...company, name: input.name }; },
    getBusinessCompany: async () => detail({ company: { ...company, name: saved.name } }),
  } });
  assert.match(container.textContent, /첫 회사 등록하기/);
  assert.equal(container.querySelectorAll('[role="progressbar"]').length, 0);
  click(button(container, '첫 회사 등록하기'));
  typeInto(field(container, '회사 이름'), 'New Company LLC');
  click(button(container, '워크플로 만들기'));
  await flush(); await flush(); await flush();
  assert.equal(saved.name, 'New Company LLC');
  assert.equal(Object.hasOwn(saved, 'account_id'), false);
  assert.match(container.textContent, /New Company LLC/);
  assert.equal(container.querySelectorAll('[role="progressbar"]').length, 6);
  assert.equal(Boolean(container.querySelector('[role="dialog"]')), false);
});

test('blocked tasks cannot complete; completing a prerequisite unlocks the next task after reload', async t => {
  let current = detail();
  const { container, calls } = await render(t, { entry: '/business/operations?company=company-1&stage=formation', stubs: {
    getBusinessCompany: async () => structuredClone(current),
    saveBusinessTask: async (companyId, taskId, input) => {
      current.tasks[0].status = input.status; current.tasks[1].blocked_by = []; current.company.revision++;
      return current.tasks[0];
    },
  } });
  assert.equal(field(container, '설립 신청 완료로 표시').disabled, true);
  click(field(container, '설립 계획 정하기 완료로 표시'));
  await flush(); await flush();
  assert.equal(field(container, '설립 신청 완료로 표시').disabled, false);
  const sent = calls.find(([name]) => name === 'saveBusinessTask');
  assert.deepEqual(sent.slice(1), ['company-1', 'task-1', { revision: 0, status: 'done' }]);
});

test('connector setup saves a reference, triggers a read and renders a persisted connection error', async t => {
  let current = detail();
  const { container, calls } = await render(t, { entry: '/business/connectors?company=company-1', stubs: {
    getBusinessCompany: async () => structuredClone(current),
    connectBusiness: async (id, provider, input) => { current.connections = [{ id: 'conn-1', provider, ...input, status: 'configured', snapshot: null, synced_at: null, last_error: '' }]; current.company.revision++; return current.connections[0]; },
    syncBusiness: async () => { current.connections[0].status = 'error'; current.connections[0].last_error = '키의 조회 권한을 확인하세요.'; return current.connections[0]; },
  } });
  click(button(container, '조회 연결')); await flush();
  const select = field(container, '연결 키');
  run(() => { select.value = 'cred-1'; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
  click(button(container, '저장하고 조회')); await flush(); await flush();
  assert.match(container.textContent, /키의 조회 권한을 확인하세요/);
  const sent = calls.find(([name]) => name === 'connectBusiness');
  assert.deepEqual(sent.slice(1), ['company-1', 'stripe', { credential_id: 'cred-1', environment: 'sandbox', config: {}, revision: 0 }]);
  assert.ok(calls.some(([name]) => name === 'syncBusiness'));
  assert.equal(Boolean(container.querySelector('input[type="password"]')), false);
});

test('ready work creates an execution ticket and opens its detail; blocked work cannot create one', async t => {
  let release;
  const { container, calls } = await render(t, { entry: '/business/operations', permissions: ['business.manage', 'tickets.create'], stubs: {
    createBusinessTaskTicket: () => new Promise(resolve => { release = resolve; }),
  } });
  assert.equal(field(container, '설립 신청 티켓 만들기').disabled, true);
  click(field(container, '설립 계획 정하기 티켓 만들기'));
  assert.equal(field(container, '설립 계획 정하기 티켓 만들기').disabled, true);
  assert.deepEqual(calls.find(([name]) => name === 'createBusinessTaskTicket').slice(1), ['company-1', 'task-1', 0]);
  await act(async () => release({ ticket: { id: 'new-ticket', title: 'Company task', status: 'backlog' } }));
  assert.match(container.textContent, /Execution ticket new-ticket/);
});

test('ticket creation requires its own permission and existing tickets are opened without creating more', async t => {
  const { container } = await render(t, { entry: '/business/operations', stubs: {
    getBusinessCompany: async () => detail({ tasks: [task({ ticket_id: 'linked-ticket', ticket: { id: 'linked-ticket', title: 'Existing ticket', status: 'review' } }), task({ id: 'unlinked', title: 'Other task' })] }),
  } });
  assert.equal(container.querySelectorAll('.business-create-ticket').length, 0);
  const link = container.querySelector('a[href="/tickets?ticket=linked-ticket"]'); assert.ok(link);
  click(link); await flush();
  assert.match(container.textContent, /Execution ticket linked-ticket/);
});

test('a late response for the previous company cannot overwrite the selected company', async t => {
  let release;
  const { container } = await render(t, { stubs: {
    listBusinessCompanies: async () => [company, { ...company, id: 'company-2', name: 'Second company' }],
    getBusinessCompany: async id => id === 'company-1' ? new Promise(resolve => { release = resolve; }) : detail({ company: { ...company, id: 'company-2', name: 'Second company' } }),
  } });
  const select = field(container, '관리할 회사');
  run(() => { select.value = 'company-2'; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
  await flush();
  await act(async () => release(detail()));
  const heading = container.querySelector('.business-hero h2'); assert.ok(heading);
  assert.equal(heading.textContent, 'Second company');
});

test('next work excludes blocked/completed tasks and money respects zero-decimal currencies', () => {
  const items = [task({ id: 'done', status: 'done' }), task({ id: 'blocked', blocked_by: ['x'] }), task({ id: 'late', due_on: '2000-01-01' }), task({ id: 'ready' })];
  assert.deepEqual(nextTasks(items).map(t => t.id), ['late', 'ready']);
  assert.equal(overdue(items[0], '2026-10-23'), false);
  assert.match(money(1234, 'USD'), /12\.34/);
  assert.match(money(1234, 'JPY'), /1,234/);
});

const offering = (price = '$297 / 년') => ({ best_for: '설립과 운영', features: ['LLC 설립', '등록 대리인'], api_access: 'partner', api_note: '파트너 키 필요', external_steps: ['본인 서명'], pricing: { plans: [{ id: 'starter', name: 'Starter', price, detail: '기본 설립' }], extra: '주정부 수수료 별도', url: 'https://example.invalid/pricing', checked_at: '2026-10-23' } });
const doola = { ...connector, id: 'doola', name: 'doola', stage: 'formation', credential_provider: 'doola', secret_fields: ['api_key'], formation: { states: ['WY', 'DE'], entity_types: ['LLC'] }, offering: offering() };
const atlas = { ...connector, id: 'atlas', name: 'Stripe Atlas', stage: 'formation', mode: 'handoff', offering: offering('$500 / 1회') };

test('service comparison separates prices and API availability; choosing persists a plan without connecting or submitting', async t => {
  let current = detail({ company: { ...company, service_choices: {} } });
  const { container, calls } = await render(t, { entry: '/business/connectors', stubs: {
    listBusinessConnectors: async () => [doola, atlas, connector], getBusinessCompany: async () => structuredClone(current),
    chooseBusinessService: async (id, stage, choice) => { current.company.service_choices[stage] = { provider: choice.provider, plan: choice.plan }; current.company.revision++; return current.company; },
  } });
  click(field(container, 'doola 비교')); click(field(container, 'Stripe Atlas 비교'));
  click(button(container, '가격 · 기능 비교'));
  const dialog = document.querySelector('[role="dialog"]'); assert.ok(dialog);
  assert.match(dialog.textContent, /\$297 \/ 년/); assert.match(dialog.textContent, /\$500 \/ 1회/);
  assert.match(dialog.textContent, /주정부 수수료 별도/); assert.match(dialog.textContent, /AWB 진행 방식/);
  click(button(dialog, '비교를 마치고 선택하기'));
  const card = field(container, 'doola 서비스'); click(button(card, '이 서비스 선택'));
  await flush(); await flush();
  assert.deepEqual(calls.find(([name]) => name === 'chooseBusinessService').slice(1), ['company-1', 'formation', { provider: 'doola', plan: 'starter', revision: 0 }]);
  assert.equal(calls.some(([name]) => ['connectBusiness', 'prepareBusinessFormation', 'submitBusinessFormation'].includes(name)), false);
  assert.match(field(container, 'doola 서비스').textContent, /우리 회사 선택/);
  click(field(container, 'Stripe 비교')); assert.match(container.textContent, /같은 업무 영역/);
});

test('formation review requires explicit consent; an ambiguous result stays visible without automatic resubmission', async t => {
  const action = { id: 'action-1', company_id: company.id, provider: 'doola', credential_id: 'credential-1', environment: 'live', payload_digest: 'reviewed-hash', revision: 1, status: 'draft', summary: { name: 'Native LLC', state: 'WY', entity_type: 'LLC', industry: 'Software' }, state_fee_cents: 10000, quoted_at: new Date().toISOString(), attempted_at: null, external_company_id: '', provider_status: '', last_error: '' };
  const review = { formation: action, request: { customer: { firstName: 'Min', lastName: 'Kim', email: 'founder@example.invalid', countryOfResidence: 'KOR' }, company: { description: 'Software tools', responsibleParty: { address: { line1: '123 Test Road', city: 'Seoul', state: 'Seoul', country: 'KOR', postalCode: '06134', phone: '+821012345678' } } } } };
  let current = detail({ formations: [action] }); let resolveSubmit;
  const { container, calls } = await render(t, { entry: '/business/connectors', stubs: {
    listBusinessConnectors: async () => [doola], getBusinessCompany: async () => structuredClone(current),
    reviewBusinessFormation: async () => structuredClone(review),
    submitBusinessFormation: () => new Promise(resolve => { resolveSubmit = resolve; }),
  } });
  click(button(container, '설립 신청 · 기록')); await flush(); await flush();
  const dialog = document.querySelector('[role="dialog"]'); assert.ok(dialog);
  assert.match(dialog.textContent, /founder@example.invalid/); assert.match(dialog.textContent, /123 Test Road/);
  assert.equal(button(dialog, '실제 설립 신청 제출').disabled, true);
  click(field(dialog, '설립 제출 확인')); click(button(dialog, '실제 설립 신청 제출'));
  assert.equal(calls.filter(([name]) => name === 'submitBusinessFormation').length, 1);
  assert.equal(button(dialog, '닫기').disabled, true);
  review.formation = { ...action, status: 'uncertain', revision: 3, last_error: '제출 결과를 확정하지 못했습니다.' }; current.formations = [review.formation];
  await act(async () => resolveSubmit(review.formation)); await flush();
  assert.match(dialog.textContent, /동일 요청으로 결과 재확인/); assert.equal(button(dialog, '동일 요청으로 결과 재확인').disabled, true);
  assert.equal(field(dialog, '설립 제출 확인').checked, false);
  assert.equal(calls.filter(([name]) => name === 'submitBusinessFormation').length, 1);
});
