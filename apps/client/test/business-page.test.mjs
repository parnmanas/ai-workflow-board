import { ui, uiPattern } from './helpers/i18n.mjs';
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
import { emptyTrademark } from '../src/components/business/trademark.logic.ts';
// Client CI runs with tsx and does not build server/dist first.
import { TRADEMARK_CONNECTORS } from '../../server/src/modules/business/connectors/trademark-registry.ts';
import { SELF_SERVICE_CONNECTORS, assessSelfService } from '../../server/src/modules/business/business-self-service.ts';
import { cashbookCsv, parseCashAmount } from '../src/components/business/cashbook.logic.ts';

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
    getBusinessCashbook: async (_id, month) => ({ month, company_revision: 0, currency: 'USD', entries: [], period: null, summary: { active_count: 0, unreconciled_count: 0, inflow_minor: 0, outflow_minor: 0, net_minor: 0, operating_in_minor: 0, operating_out_minor: 0 } }),
    listTrademarkIntegrations: async () => ({ connectors: TRADEMARK_CONNECTORS.map(c => c.descriptor), connections: [], records: [], actions: [] }),
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
  const element = [...root.querySelectorAll('button')].find(b => b.textContent.includes(ui(label)));
  assert.ok(element, `button ${label} exists`); return element;
}
function field(root, label) {
  const element = root.querySelector(`[aria-label="${ui(label)}"]`);
  assert.ok(element, `field ${label} exists`); return element;
}

test('without business permission the page makes no business requests, and marketing navigation remains usable', async t => {
  const { container, calls } = await render(t, { permissions: ['marketing.manage'] });
  assert.match(container.textContent, uiPattern("Business 권한이 필요합니다"));
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
  assert.match(container.textContent, uiPattern("첫 회사 등록하기"));
  assert.equal(container.querySelectorAll('[role="progressbar"]').length, 0);
  click(button(container, ui("첫 회사 등록하기")));
  typeInto(field(container, ui("회사 이름")), 'New Company LLC');
  click(button(container, ui("워크플로 만들기")));
  await flush(); await flush(); await flush();
  assert.equal(saved.name, 'New Company LLC');
  assert.equal(Object.hasOwn(saved, 'account_id'), false);
  assert.match(container.textContent, /New Company LLC/);
  assert.equal(container.querySelectorAll('[role="progressbar"]').length, 7);
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
  assert.equal(field(container, `설립 신청 ${ui('완료로 표시')}`).disabled, true);
  click(field(container, `설립 계획 정하기 ${ui('완료로 표시')}`));
  await flush(); await flush();
  assert.equal(field(container, `설립 신청 ${ui('완료로 표시')}`).disabled, false);
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
  click(button(container, ui("조회 연결"))); await flush();
  const select = field(container, ui("연결 키"));
  run(() => { select.value = 'cred-1'; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
  click(button(container, ui("저장하고 조회"))); await flush(); await flush();
  assert.match(container.textContent, /키의 조회 권한을 확인하세요/);
  const sent = calls.find(([name]) => name === 'connectBusiness');
  assert.deepEqual(sent.slice(1), ['company-1', 'stripe', { credential_id: 'cred-1', environment: 'sandbox', config: {}, revision: 0 }]);
  assert.ok(calls.some(([name]) => name === 'syncBusiness'));
  assert.equal(Boolean(container.querySelector('input[type="password"]')), false);
});

test('work opens its own history; explicit ticket creation stays in that work item', async t => {
  let linked = false;
  const currentTask = () => task(linked ? { ticket_id: 'new-ticket', ticket: { id: 'new-ticket', title: 'Company task', status: 'backlog' } } : {});
  const { container, calls } = await render(t, { entry: '/business/operations', permissions: ['business.manage', 'tickets.create'], stubs: {
    getBusinessTask: async () => ({ task: currentTask(), company_revision: 0, entries: [], next_before: null, result: null, decision: null, open_requests: [] }),
    getTicketComments: async () => [],
    createBusinessTaskTicket: async () => { linked = true; return { ticket: currentTask().ticket }; },
  } });
  assert.equal(calls.some(([name]) => name === 'createBusinessTaskTicket'), false);
  click(button(container, '설립 계획 정하기')); await flush(); await flush();
  assert.match(container.textContent, uiPattern('진행 과정과 변경 내역'));
  click(button(container, '티켓 만들기')); await flush(); await flush();
  assert.deepEqual(calls.find(([name]) => name === 'createBusinessTaskTicket').slice(1), ['company-1', 'task-1', 0]);
  assert.ok(container.querySelector('.business-task-workspace'));
  assert.match(container.textContent, uiPattern('Backlog'));
});

test('blocked work and missing ticket permission cannot create execution tickets', async t => {
  const blocked = task({ blocked_by: ['task-2'] });
  const { container } = await render(t, { entry: '/business/operations?task=task-1', permissions: ['business.manage', 'tickets.create'], stubs: {
    getBusinessTask: async () => ({ task: blocked, company_revision: 0, entries: [], next_before: null, result: null, decision: null, open_requests: [] }),
  } });
  assert.equal(button(container, '티켓 만들기').disabled, true);
});

test('existing ticket comments are readable inside business without ticket creation permission', async t => {
  const linked = task({ ticket_id: 'linked-ticket', ticket: { id: 'linked-ticket', title: 'Existing ticket', status: 'review' } });
  const { container } = await render(t, { entry: '/business/operations?task=task-1', stubs: {
    getBusinessTask: async () => ({ task: linked, company_revision: 0, entries: [], next_before: null, result: null, decision: null, open_requests: [] }),
    getTicketComments: async () => [{ id: 'comment', content: 'Evidence and formation research from the agent', author: 'Runtime', author_type: 'agent', created_at: '2026-10-27T00:00:00Z', attachments: [] }],
  } });
  await flush();
  assert.match(container.textContent, /Evidence and formation research/);
  assert.equal([...container.querySelectorAll('button')].some(b => b.textContent === ui('티켓 만들기')), false);
  click(button(container, '이 답변으로 결과 정리'));
  assert.equal(field(container, '업무 기록 내용').value, 'Evidence and formation research from the agent');
});

test('a late response for the previous company cannot overwrite the selected company', async t => {
  let release;
  const { container } = await render(t, { stubs: {
    listBusinessCompanies: async () => [company, { ...company, id: 'company-2', name: 'Second company' }],
    getBusinessCompany: async id => id === 'company-1' ? new Promise(resolve => { release = resolve; }) : detail({ company: { ...company, id: 'company-2', name: 'Second company' } }),
  } });
  const select = field(container, ui("관리할 회사"));
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
  click(button(container, ui("가격 · 기능 비교")));
  const dialog = document.querySelector('[role="dialog"]'); assert.ok(dialog);
  assert.match(dialog.textContent, /\$297 \/ 년/); assert.match(dialog.textContent, /\$500 \/ 1회/);
  assert.match(dialog.textContent, /주정부 수수료 별도/); assert.match(dialog.textContent, uiPattern("AWB 진행 방식"));
  click(button(dialog, ui("비교를 마치고 선택하기")));
  const card = field(container, 'doola 서비스'); click(button(card, ui("이 서비스 선택")));
  await flush(); await flush();
  assert.deepEqual(calls.find(([name]) => name === 'chooseBusinessService').slice(1), ['company-1', 'formation', { provider: 'doola', plan: 'starter', revision: 0 }]);
  assert.equal(calls.some(([name]) => ['connectBusiness', 'prepareBusinessFormation', 'submitBusinessFormation'].includes(name)), false);
  assert.match(field(container, 'doola 서비스').textContent, uiPattern("우리 회사 선택"));
  click(field(container, 'Stripe 비교')); assert.match(container.textContent, uiPattern("같은 업무 영역의 서비스를 비교하세요. 비교 목록을 비우면 다른 영역을 선택할 수 있습니다."));
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
  click(button(container, ui("설립 신청 · 기록"))); await flush(); await flush();
  const dialog = document.querySelector('[role="dialog"]'); assert.ok(dialog);
  assert.match(dialog.textContent, /founder@example.invalid/); assert.match(dialog.textContent, /123 Test Road/);
  assert.equal(button(dialog, ui("실제 설립 신청 제출")).disabled, true);
  click(field(dialog, ui("설립 제출 확인"))); click(button(dialog, ui("실제 설립 신청 제출")));
  assert.equal(calls.filter(([name]) => name === 'submitBusinessFormation').length, 1);
  assert.equal(button(dialog, ui("닫기")).disabled, true);
  review.formation = { ...action, status: 'uncertain', revision: 3, last_error: '제출 결과를 확정하지 못했습니다.' }; current.formations = [review.formation];
  await act(async () => resolveSubmit(review.formation)); await flush();
  assert.match(dialog.textContent, uiPattern("동일 요청으로 결과 재확인")); assert.equal(button(dialog, ui("동일 요청으로 결과 재확인")).disabled, true);
  assert.equal(field(dialog, ui("설립 제출 확인")).checked, false);
  assert.equal(calls.filter(([name]) => name === 'submitBusinessFormation').length, 1);
});

const trademark = { ...emptyTrademark(company.name), id: 'mark-1', company_id: company.id, account_id: company.account_id, revision: 0, mark: 'Orbit', domicile_country: 'KR', classes: [9, 42], attorney_email: 'lawyer@example.invalid', attorney_name: 'Counsel', created_at: '2026-10-23T00:00:00Z' };
const trademarkPayload = { from: 'legal@example.invalid', to: trademark.attorney_email, reply_to: 'owner@example.invalid', subject: 'Trademark inquiry', text: 'Please send an engagement agreement for review.' };
const trademarkMail = { id: 'mail-1', company_id: company.id, trademark_id: trademark.id, provider: 'resend', credential_id: 'resend-1', payload_digest: 'a'.repeat(64), revision: 0, status: 'draft', to: trademark.attorney_email, subject: trademarkPayload.subject, created_at: '2026-10-23T00:00:00Z', first_attempted_at: null, last_error: '' };

test('a trademark connector saves server credentials and polling settings without sending or starting OAuth', async t => {
  const state = { connectors: TRADEMARK_CONNECTORS.map(c => c.descriptor), connections: [], records: [], actions: [] };
  const { container, calls } = await render(t, { entry: '/business/operations?stage=trademark', permissions: ['business.manage', 'admin.credentials'], stubs: {
    listBusinessTrademarks: async () => ({ cases: [trademark], mail: [] }), listTrademarkIntegrations: async () => structuredClone(state),
    createCredential: async () => ({ id: 'tsdr-key', name: 'TSDR key' }),
    configureTrademarkIntegration: async (_company, _mark, input) => { state.connections.push({ ...input, id: 'tsdr-connection', status: 'configured', ready: true, revision: 0 }); },
  } });
  click(button(field(container, 'USPTO · TSDR 커넥터'), ui("연결 설정"))); await flush();
  const dialog = document.querySelector('[role="dialog"]');
  const key = field(dialog, ui("연동 credential")); run(() => { key.value = '__new__'; key.dispatchEvent(new window.Event('change', { bubbles: true })); });
  const secret = field(dialog, '연동 api_key'); assert.equal(secret.type, 'password'); typeInto(secret, 'test-tsdr-secret');
  const interval = field(dialog, ui("자동 수집 간격")); run(() => { interval.value = '60'; interval.dispatchEvent(new window.Event('change', { bubbles: true })); });
  assert.equal(calls.some(([name]) => name === 'createCredential'), false);
  click(button(dialog, ui("연결 설정 저장"))); await flush(); await flush();
  const credentials = calls.find(([name]) => name === 'createCredential')[1];
  assert.equal(credentials.agent_env, false); assert.equal(credentials.account_id, company.account_id); assert.equal(credentials.provider, 'uspto_tsdr');
  assert.deepEqual(calls.find(([name]) => name === 'configureTrademarkIntegration').slice(1), [company.id, trademark.id, { provider: 'uspto_tsdr', credential_id: 'tsdr-key', config: {}, auto_sync: true, interval_minutes: 60, revision: undefined }]);
  assert.equal(calls.some(([name]) => /sendTrademark|authorizeTrademark/.test(name)), false);
  assert.doesNotMatch(container.textContent, /test-tsdr-secret/); assert.match(container.textContent, uiPattern('{0}분마다 자동 수집', { 0: 60 }));
});

test('a lost contract response reloads its durable state and only allows read reconciliation', async t => {
  const connection = { id: 'doc-1', provider: 'docusign', ready: true, status: 'connected', auto_sync: true, interval_minutes: 15, config: {}, identity: { name: 'Contract owner' } };
  let action = { id: 'contract-1', integration_id: connection.id, kind: 'contract', status: 'draft', payload_digest: 'b'.repeat(64), revision: 0, title: 'Orbit agreement', review: { subject: 'Orbit agreement', template_name: 'Approved terms', roles: [{ role: 'Client', name: 'Owner', email: 'owner@example.invalid' }], documents: ['Agreement.pdf'] } };
  const { container, calls } = await render(t, { entry: '/business/operations?stage=trademark', stubs: {
    listBusinessTrademarks: async () => ({ cases: [trademark], mail: [] }),
    listTrademarkIntegrations: async () => ({ connectors: TRADEMARK_CONNECTORS.map(c => c.descriptor), connections: [connection], records: [], actions: [structuredClone(action)] }),
    reviewTrademarkAction: async () => structuredClone(action),
    sendTrademarkAction: async () => { action = { ...action, status: 'uncertain', revision: 2 }; throw new Error('HTTP response lost'); },
    reconcileTrademarkAction: async () => { action = { ...action, status: 'sent', revision: 3, external_id: 'confirmed-envelope', external_status: 'completed' }; return structuredClone(action); },
  } });
  click(button(field(container, 'DocuSign 커넥터'), ui("검토·발송 이어가기"))); await flush(); await flush();
  const dialog = document.querySelector('[role="dialog"]');
  assert.match(dialog.textContent, /Approved terms/); assert.match(dialog.textContent, /owner@example.invalid/); assert.match(dialog.textContent, /Agreement.pdf/);
  assert.equal(button(dialog, ui("검토한 요청 실제 발송")).disabled, true);
  click(dialog.querySelector('input[type="checkbox"]')); click(button(dialog, ui("검토한 요청 실제 발송"))); await flush(); await flush();
  assert.match(dialog.textContent, /HTTP response lost/);
  assert.equal([...dialog.querySelectorAll('button')].some(el => el.textContent.includes(ui("검토한 요청 실제 발송"))), false);
  assert.equal(button(dialog, ui("기존 발송 원문 대조")).disabled, true);
  click(dialog.querySelector('input[type="checkbox"]')); click(button(dialog, ui("기존 발송 원문 대조"))); await flush(); await flush();
  assert.equal(calls.filter(([name]) => name === 'sendTrademarkAction').length, 1);
  assert.equal(calls.filter(([name]) => name === 'reconcileTrademarkAction').length, 1);
  assert.equal(button(dialog, ui("완료된 서명본 다운로드")).disabled, false);
});

test('existing companies can add a trademark checklist and configure each implemented integration', async t => {
  let current = detail();
  const { container, calls } = await render(t, { entry: '/business/operations?stage=trademark', stubs: {
    getBusinessCompany: async () => structuredClone(current), listBusinessTrademarks: async () => ({ cases: [trademark], mail: [] }),
    initializeTrademarkTasks: async () => { current.tasks.push(task({ id: 'tm-task', stage: 'trademark', title: '상표 자료 정리' })); current.company.revision++; return { created: 8 }; },
  } });
  assert.match(container.textContent, uiPattern("미국 변호사 대리 필요")); assert.match(container.textContent, /\$700\.00/);
  for (const { descriptor } of TRADEMARK_CONNECTORS) assert.ok(field(container, `${descriptor.name} 커넥터`));
  assert.match(container.textContent, new RegExp('0' + ui('개 사용 가능')));
  assert.match(container.textContent, uiPattern("메일·계약·로펌·공식 상태를 기능별 커넥터로 연결합니다. 자동 수집은 서버에서 계속되며 외부 발송은 원문을 검토한 뒤 실행합니다. 읽어 온 기한·회신은 담당자 확인 자료입니다."));
  click(button(container, ui("상표 출원 절차 추가"))); await flush(); await flush();
  assert.deepEqual(calls.find(([name]) => name === 'initializeTrademarkTasks').slice(1), [company.id, 0]);
  assert.equal([...container.querySelectorAll('button')].some(el => el.textContent.includes(ui("상표 출원 절차 추가"))), false);
  assert.match(container.textContent, /상표 자료 정리/);
});

test('a US territory domicile is not shown as requiring counsel under the foreign domicile rule', async t => {
  const { container } = await render(t, { entry: '/business/operations?stage=trademark', stubs: {
    listBusinessTrademarks: async () => ({ cases: [{ ...trademark, domicile_country: 'PR' }], mail: [] }),
  } });
  const facts = container.querySelector('.business-trademark-facts');
  assert.match(facts.textContent, /PR/);
  assert.doesNotMatch(facts.textContent, uiPattern("미국 변호사 대리 필요"));
  assert.match(facts.textContent, uiPattern("설립 주소와 별도로 확인"));
});

test('trademark form keeps actual domicile separate from incorporation and persists attorney, contract and deadlines', async t => {
  let saved;
  const { container } = await render(t, { entry: '/business/operations?stage=trademark', stubs: {
    listBusinessTrademarks: async () => ({ cases: saved ? [{ ...trademark, ...saved }] : [], mail: [] }),
    saveBusinessTrademark: async (_companyId, _id, input) => { saved = input; return { ...trademark, ...input }; },
  } });
  click(button(container, ui("상표 추가")));
  const dialog = container.querySelector('[role="dialog"]'); assert.ok(dialog);
  assert.equal(field(dialog, ui("실제 본점 국가 코드")).value, '', 'incorporating in the US does not infer US domicile');
  typeInto(field(dialog, ui("상표명 · 로고 식별명")), 'New Brand'); typeInto(field(dialog, ui("실제 본점 국가 코드")), 'KR'); typeInto(field(dialog, ui("검토할 상품류")), '9, 42');
  click(button(dialog, '2. 변호사 · 계약'));
  typeInto(field(dialog, ui("변호사 이메일")), 'lawyer@example.invalid'); typeInto(field(dialog, ui("계약 · 서명 서비스 링크")), 'https://sign.example.invalid/agreement');
  click(button(dialog, '3. 진행 · 회신')); typeInto(field(dialog, ui("기한 출처 · 확인 내용")), 'Counsel confirmation'); typeInto(field(dialog, ui("변호사 회신 · 진행 메모")), 'Awaiting agreement');
  click(button(dialog, ui("상표 기록 저장"))); await flush(); await flush();
  assert.equal(saved.domicile_country, 'KR'); assert.deepEqual(saved.classes, [9, 42]); assert.equal(saved.attorney_email, 'lawyer@example.invalid');
  assert.equal(saved.phase, 'preparing'); assert.equal(saved.notes, 'Awaiting agreement');
  assert.ok(container.querySelector('a[href="https://sign.example.invalid/agreement"]'));
});

test('trademark mail needs explicit review consent and never automatically retries an ambiguous send', async t => {
  let resolveSend;
  const { container, calls } = await render(t, { entry: '/business/operations?stage=trademark', stubs: {
    listBusinessTrademarks: async () => ({ cases: [trademark], mail: [trademarkMail] }),
    reviewTrademarkMail: async () => ({ mail: trademarkMail, payload: trademarkPayload }),
    sendTrademarkMail: () => new Promise(resolve => { resolveSend = resolve; }),
  } });
  click(button(container, ui("검토·발송 기록 이어가기"))); await flush();
  const dialog = container.querySelector('[role="dialog"]'); assert.ok(dialog);
  assert.match(dialog.textContent, /lawyer@example.invalid/); assert.equal(button(dialog, ui("확인한 메일 실제 발송")).disabled, true);
  const checkbox = dialog.querySelector('input[type="checkbox"]'); assert.ok(checkbox); click(checkbox);
  click(button(dialog, ui("확인한 메일 실제 발송"))); assert.equal(button(dialog, ui("닫기")).disabled, true);
  await act(async () => resolveSend({ ...trademarkMail, status: 'uncertain', revision: 2, first_attempted_at: new Date().toISOString(), last_error: '접수 결과 확인 필요' })); await flush();
  assert.equal(button(dialog, ui("같은 요청으로 접수 재확인")).disabled, true); assert.equal(checkbox.checked, false);
  assert.equal(calls.filter(([name]) => name === 'sendTrademarkMail').length, 1);
  assert.match(dialog.textContent, uiPattern("발송 원문 대조"));
});

test('failed server review retrieval blocks mail sending after a draft was persisted', async t => {
  const { container, calls } = await render(t, { entry: '/business/operations?stage=trademark', stubs: {
    listBusinessTrademarks: async () => ({ cases: [trademark], mail: [] }),
    listBusinessCredentials: async () => [{ id: 'resend-1', provider: 'resend', name: 'Legal mail' }],
    draftTrademarkMail: async () => trademarkPayload,
    prepareTrademarkMail: async () => trademarkMail,
    reviewTrademarkMail: async () => { throw new Error('Review unavailable'); },
  } });
  click(button(container, ui("변호사 메일 작성"))); await flush();
  const dialog = container.querySelector('[role="dialog"]'); assert.ok(dialog);
  const key = field(dialog, ui("Resend 연결 키")); run(() => { key.value = 'resend-1'; key.dispatchEvent(new window.Event('change', { bubbles: true })); });
  click(button(dialog, ui("발송 전 검토"))); await flush(); await flush();
  assert.equal(calls.filter(([name]) => name === 'prepareTrademarkMail').length, 1);
  assert.match(dialog.textContent, uiPattern("저장된 발송 원문을 다시 확인해야 합니다. 창을 닫고 기존 검토 기록을 다시 열어 주세요. 발송은 차단되어 있습니다."));
  const checkbox = dialog.querySelector('input[type="checkbox"]'); assert.ok(checkbox); click(checkbox);
  assert.equal(button(dialog, ui("확인한 메일 실제 발송")).disabled, true);
  assert.equal(calls.some(([name]) => name === 'sendTrademarkMail'), false);
});

test('cashbook decimal entry and CSV preserve cents and neutralize formula fields', () => {
  assert.equal(parseCashAmount('0.29'), 29);
  assert.equal(parseCashAmount('-100.05', true), -10005);
  for (const value of ['1.001', '1e3', 'NaN', '-1', '0', '20000000.01']) assert.throws(() => parseCashAmount(value));
  const csv = cashbookCsv({ entries: [{ id: 'row', date: '2020-01-01', kind: 'capital_in', amount_minor: 29, currency: 'USD', description: '=HYPERLINK("bad")', evidence: '+command', reconciled: true, voided: true, void_reason: 'duplicate' }] });
  assert.ok(csv.includes('"29"')); assert.ok(csv.includes("'=HYPERLINK")); assert.ok(csv.includes("'+command")); assert.ok(csv.includes('"true","true"'));
});

test('DIY formation checks every condition, explains overseas routes and saves confirmed facts', async t => {
  let current = detail();
  const manual = SELF_SERVICE_CONNECTORS[0].descriptor;
  const { container, calls } = await render(t, { entry: '/business/connectors?company=company-1', stubs: {
    listBusinessConnectors: async () => [manual], getBusinessCompany: async () => structuredClone(current),
    assessBusinessSelfService: async (_id, provider, plan, answers) => ({ ...assessSelfService(current.company, provider, plan, answers ?? current.company.self_service?.[provider]?.answers ?? {}), company_revision: current.company.revision, stale: false }),
    chooseBusinessService: async (_id, stage, input) => { current.company.service_choices = { [stage]: { provider: input.provider, plan: input.plan } }; current.company.self_service = { [input.provider]: { answers: input.self_service_answers } }; current.company.revision++; return current.company; },
  } });
  const select = field(container, '직접 LLC 설립 가격 플랜'); run(() => { select.value = 'DE'; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
  click(button(container, ui("조건 확인 · 직접 선택"))); await flush(); await flush();
  const dialog = container.querySelector('[role="dialog"]'); assert.ok(dialog);
  assert.equal(button(dialog, ui("조건을 확인하고 직접 처리 선택")).disabled, true);
  assert.match(dialog.textContent, uiPattern("해외에서 운영해도 직접 처리할 수 있나요?"));
  const answer = async (key, yes) => {
    const inputs = dialog.querySelectorAll(`input[name="${key}"]`); assert.ok(inputs.length); click(inputs[yes ? 0 : 1]); await flush(); await flush();
  };
  await answer('operator_abroad', true);
  assert.ok(dialog.querySelector('input[name="residence_reviewed"]'));
  for (const key of ['standard_llc', 'name_checked', 'registered_agent', 'authorized_filer', 'compliance_plan', 'residence_reviewed']) await answer(key, true);
  for (const key of ['principal_us', 'responsible_tax_id']) await answer(key, false);
  await answer('foreign_owned', true);
  assert.match(dialog.textContent, /IRS 전화·팩스·우편/);
  assert.match(dialog.textContent, /5472/);
  assert.equal(button(dialog, ui("조건을 확인하고 직접 처리 선택")).disabled, false);
  click(button(dialog, ui("조건을 확인하고 직접 처리 선택"))); await flush(); await flush(); await flush();
  const saved = calls.find(([name]) => name === 'chooseBusinessService');
  assert.equal(saved[3].self_service_answers.operator_abroad, true); assert.equal(saved[3].self_service_answers.responsible_tax_id, false);
  assert.match(container.textContent, uiPattern("직접 처리 진행 안내"));
  assert.equal(Boolean(container.querySelector('[role="dialog"]')), false, '직접 처리 선택 후 조건 확인 대화상자가 닫힌다');
});

test('a failed work journal save preserves the draft and reuses the same request ID on retry', async t => {
  let attempts = 0;
  const sent = [];
  const state = { task: task(), company_revision: 0, entries: [], next_before: null, result: null, decision: null, open_requests: [] };
  const { container, calls } = await render(t, { entry: '/business/operations?task=task-1', stubs: {
    getBusinessTask: async () => structuredClone(state),
    addBusinessTaskEntry: async (_company, _task, input) => {
      sent.push(input); attempts++;
      if (attempts === 1) throw new Error('Connection interrupted; retry the saved request');
      const record = { ...input, id: input.request_id, task_id: 'task-1', revision: 1, created_at: '2026-10-27T00:00:00Z', author: 'Owner', author_type: 'user', changes: null };
      state.entries = [record]; state.open_requests = [record]; state.company_revision = 1;
      return record;
    },
  } });
  typeInto(field(container, '업무 기록 내용'), 'Revise the costs in the formation plan');
  click(button(container, '기록 남기기')); await flush(); await flush();
  assert.equal(field(container, '업무 기록 내용').value, 'Revise the costs in the formation plan');
  assert.match(container.textContent, /Connection interrupted/);
  click(button(container, '기록 남기기')); await flush(); await flush();
  assert.equal(sent.length, 2);
  assert.equal(sent[0].request_id, sent[1].request_id);
  assert.equal(field(container, '업무 기록 내용').value, '');
  assert.match(container.textContent, /Revise the costs/);
  assert.equal(calls.some(([name]) => name === 'createBusinessTaskTicket' || name === 'addComment'), false);
});
