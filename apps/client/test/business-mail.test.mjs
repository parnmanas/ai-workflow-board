import { ui, uiPattern } from './helpers/i18n.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, mount, click, typeInto, run, React, act } from './helpers/jsdom.mjs';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { api } from '../src/api.ts';
import { AuthProvider } from '../src/contexts/AuthContext.tsx';
import { ToastProvider } from '../src/contexts/ToastContext.tsx';
import { BoardStreamProvider } from '../src/contexts/BoardStreamContext.tsx';
import { installFakeEventSource } from './helpers/boardStream.mjs';
import { NotificationProvider } from '../src/contexts/NotificationContext.tsx';
import BusinessMailPage from '../src/components/business/BusinessMailPage.tsx';
import BusinessLayout from '../src/components/business/BusinessLayout.tsx';
import { composeFrom, composeRecipients, composeSubject, defaultExpanded, parseRecipients, splitQuoted } from '../src/components/business/business-mail.logic.ts';

const h = React.createElement;
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const button = (container, label) => { const node = [...container.querySelectorAll('button')].find(b => b.textContent.trim() === ui(label)); if (!node) throw new Error(`Missing button ${label}`); return node; };
const connection = { id: 'c1', account_id: 'a1', company_id: null, name: 'Operations NAS', purpose: 'operations', provider: 'smtp_imap', credential_id: 'key', revision: 0, enabled: true, interval_minutes: 5, status: 'connected', synced_at: '', last_error: '', busy: false, config: { addresses: ['ops@example.com'], smtp: { host: 'smtp.example.com', port: 587, tls: 'starttls', username: 'ops' }, imap: { host: 'imap.example.com', port: 993, tls: 'implicit', username: 'ops', folder: 'INBOX' } } };
const message = { id: 'm1', connection_id: 'c1', direction: 'inbound', status: 'received', from: 'vendor@example.com', to: ['ops@example.com'], subject: 'Invoice', preview: 'Private mail', text: '<img src="https://tracker.example.com/x">Untrusted message', date: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z', confirmed: false, note: '', revision: 0, attachments: [], last_error: '' };
const summary = (messages, patch = {}) => ({ id: 't1', latest_id: messages.at(-1).id, subject: messages[0].subject, preview: 'Private mail', last_at: messages.at(-1).date,
  count: messages.length, inbound: messages.filter(m => m.direction === 'inbound').length, outbound: messages.filter(m => m.direction === 'outbound').length,
  unconfirmed: messages.filter(m => m.direction === 'inbound' && !m.confirmed).length, attachments: 0, senders: [...new Set(messages.map(m => m.from))],
  connection_ids: ['c1'], statuses: [], replies: [], ...patch });
/** Stubs share one mailbox so confirmation and sending show up on the next refetch, like the server. */
async function render(t, { entry = '/business/mail', permissions = ['business.manage'], stubs = {}, notifications = false, mails = [{ ...message }] } = {}) {
  const dom = setupDom(); globalThis.localStorage = dom.window.localStorage; globalThis.sessionStorage = dom.window.sessionStorage;
  globalThis.Audio = class { play() { return Promise.resolve(); } pause() {} };
  localStorage.setItem('auth_token', 'test');
  const { FakeEventSource, uninstall } = installFakeEventSource();
  const calls = []; const original = {};
  const box = mails.map(m => ({ ...m }));
  const find = id => box.find(m => m.id === id);
  for (const [key, fn] of Object.entries({
    getMe: async () => ({ id: 'u1', name: 'Owner', status: 'active', resolved_permissions: permissions, accounts: [{ id: 'a1', name: 'Personal' }] }),
    listBusinessCompanies: async () => [{ id: 'co1', account_id: 'a1', name: 'Company One' }],
    listBusinessMailConnections: async () => ({ connectors: [{ id: 'smtp_imap', name: 'SMTP · IMAP', note: 'Application passwords' }, { id: 'jmap', name: 'JMAP', note: 'API token' }], connections: [connection, { ...connection, id: 'c2', account_id: 'a2', name: 'Accounting', purpose: 'accounting' }], credentials: [{ id: 'key', name: 'Mail key', account_id: 'a1' }] }),
    listBusinessMail: async () => ({ messages: box.map(m => ({ ...m })), total: box.length, offset: 0, limit: 50 }),
    getBusinessMail: async id => ({ ...find(id) }),
    listBusinessMailThreads: async () => ({ view: 'threads', threads: [summary(box)], total: 1, offset: 0, limit: 50 }),
    getBusinessMailThread: async id => ({ ...find(id), thread: { id: 't1', total: box.length, messages: box.map(m => ({ ...m })) } }),
    sendBusinessMail: async (connectionId, input) => { const sent = { ...message, id: `sent-${box.length}`, connection_id: connectionId, direction: 'outbound', status: 'accepted', from: input.from, to: input.to, subject: input.subject, text: input.text, confirmed: false, date: '2026-01-03T00:00:00Z' }; box.push(sent); return sent; },
    getBusinessMailReply: async () => null,
    listTemplateHosts: async () => [{ id: 'mail-host', name: 'Mail host' }],
    listAgentTemplates: async () => [{ id: 'mail-template', name: 'Mail responder', host_id: 'mail-host', cli: 'codex', model: null, effort: null, runtime_config: { strategy: 'single', permission_mode: 'approve' } }],
    listCredentials: async () => [],
    getProjects: async () => [],
    getHostModels: async () => ({ models: { codex: [] }, labels: {}, refreshed_at: new Date().toISOString() }),
    validateRuntimeSpec: async (_accountId, spec) => ({ ok: true, spec }),
    getUnreadMentions: async () => ({ count: 0, items: [] }),
    getChatUnreadCounts: async () => ({ total: 0, perRoom: {} }),
    getTicketUnreadCounts: async () => ({ total: 0, perTicket: {} }),
    confirmBusinessMail: async (id, input) => { const row = find(id); Object.assign(row, input, { revision: row.revision + 1, confirmed_at: new Date().toISOString() }); return { ...row }; },
    configureBusinessMail: async input => ({ ...input, id: 'c1' }),
    ...stubs,
  })) { original[key] = api[key]; api[key] = async (...args) => { calls.push([key, ...args]); return fn(...args); }; }
  const routes = h(Routes, null, h(Route, { element: h(BusinessLayout) }, h(Route, { path: '/business/mail', element: h(BusinessMailPage) })));
  const view = mount(h(MemoryRouter, { initialEntries: [entry] }, h(ToastProvider, null, h(AuthProvider, null,
    h(BoardStreamProvider, null, notifications ? h(NotificationProvider, null, routes) : routes)))));
  t.after(() => { view.unmount(); Object.assign(api, original); uninstall(); dom.cleanup(); });
  await flush(); await flush(); await flush();
  return { ...view, calls, FakeEventSource };
}

test('Business mail opens conversations by default and preserves other filters while selecting a company or purpose', async t => {
  const { container, calls } = await render(t);
  assert.equal(Boolean(container.querySelector('.business-company-picker')), false);
  assert.match(container.textContent, uiPattern("비즈니스 메일"));
  assert.deepEqual(calls.find(c => c[0] === 'listBusinessMailThreads')[1], {});
  assert.equal(calls.some(c => c[0] === 'listBusinessMail'), false);
  assert.equal(button(container, ui('대화별')).getAttribute('aria-pressed'), 'true');
  click(button(container, ui("필터"))); await flush();
  const company = container.querySelector(`[aria-label="${ui("모든 회사")}"]`);
  run(() => { company.value = 'co1'; company.dispatchEvent(new window.Event('change', { bubbles: true })); }); await flush(); await flush();
  const purpose = container.querySelector(`[aria-label="${ui("모든 업무 용도")}"]`);
  run(() => { purpose.value = 'accounting'; purpose.dispatchEvent(new window.Event('change', { bubbles: true })); }); await flush(); await flush();
  assert.deepEqual(calls.filter(c => c[0] === 'listBusinessMailThreads').at(-1)[1], { company_id: 'co1', purpose: 'accounting' });
  click(button(container, ui("필터 초기화"))); await flush(); await flush();
  assert.deepEqual(calls.filter(c => c[0] === 'listBusinessMailThreads').at(-1)[1], {});
});

test('reading mail renders text safely and does not confirm until the processing action is clicked', async t => {
  const { container, calls } = await render(t);
  click(container.querySelector('.business-mail-row')); await flush(); await flush();
  assert.deepEqual(calls.find(c => c[0] === 'getBusinessMailThread').slice(1), ['m1']);
  assert.equal(calls.some(c => c[0] === 'confirmBusinessMail'), false);
  assert.equal(container.querySelectorAll('.business-mail-body img').length, 0);
  assert.match(container.querySelector('.business-mail-body').textContent, /Untrusted message/);
  typeInto(container.querySelector('textarea'), 'Invoice recorded');
  click(button(container, ui("확인 완료"))); await flush(); await flush();
  assert.deepEqual(calls.find(c => c[0] === 'confirmBusinessMail').slice(1), ['m1', { revision: 0, confirmed: true, note: 'Invoice recorded' }]);
  assert.match(container.textContent, uiPattern("미확인으로 되돌리기"));
  assert.equal(container.querySelector('textarea').value, 'Invoice recorded');
});

test('the mail-by-mail view stays available and keeps its own detail', async t => {
  const { container, calls } = await render(t);
  click(button(container, ui('메일별'))); await flush(); await flush();
  assert.deepEqual(calls.filter(c => c[0] === 'listBusinessMail').at(-1)[1], {});
  click(container.querySelector('.business-mail-row')); await flush(); await flush();
  assert.deepEqual(calls.find(c => c[0] === 'getBusinessMail').slice(1), ['m1']);
  assert.equal(Boolean(container.querySelector('.business-mail-conversation')), false, 'the mail view has no conversation pane');
  assert.match(container.querySelector('.business-mail-detail > .business-mail-body').textContent, /Untrusted message/);
  click(button(container, ui('필터'))); click(button(container, ui('필터 초기화'))); await flush(); await flush();
  assert.equal(button(container, ui('메일별')).getAttribute('aria-pressed'), 'true', 'resetting filters keeps the chosen view');
});

const conversation = [
  { ...message, id: 'm1', confirmed: true, text: 'Please send the invoice.', date: '2026-01-01T00:00:00Z' },
  { ...message, id: 'm2', direction: 'outbound', status: 'accepted', from: 'ops@example.com', to: ['vendor@example.com'], subject: 'Re: Invoice', text: 'Attached.', date: '2026-01-01T02:00:00Z' },
  { ...message, id: 'm3', subject: 'RE: Invoice', to: ['ops@example.com', 'cc@example.com'], reply_to: 'billing@example.com', text: 'Thanks, received.\n\nOn Thu, ops@example.com wrote:\n> Attached.', date: '2026-01-02T00:00:00Z' },
];

test('a conversation lists replies oldest first, opens the newest and folds quoted text', async t => {
  const { container } = await render(t, { mails: conversation });
  const row = container.querySelector('.business-mail-thread-row');
  assert.match(row.querySelector('.business-mail-senders').textContent, new RegExp(`^vendor, ${ui('나')}3$`));
  assert.match(row.textContent, uiPattern('미확인 {0}', { 0: 1 }));
  click(row); await flush(); await flush();
  const articles = [...container.querySelectorAll('.business-mail-message')];
  assert.deepEqual(articles.map(a => a.dataset.mailId), ['m1', 'm2', 'm3']);
  assert.deepEqual(articles.map(a => a.querySelector('.business-mail-message-head').getAttribute('aria-expanded')), ['false', 'false', 'true']);
  assert.equal(articles[1].querySelector('.business-mail-message-from strong').textContent, ui('나'));
  const latest = articles[2];
  assert.equal(latest.querySelector('.business-mail-body').textContent, 'Thanks, received.');
  click(latest.querySelector('.business-mail-quote-toggle')); await flush();
  assert.match(latest.querySelector('.business-mail-quoted').textContent, /> Attached\./);
  click(articles[0].querySelector('.business-mail-message-head')); await flush();
  assert.equal(articles[0].querySelector('.business-mail-body').textContent, 'Please send the invoice.');
});

test('reply, reply all and forward prefill from the mail and resend with the same request ID after a failure', async t => {
  let fail = true;
  const { container, calls } = await render(t, { mails: conversation, stubs: {} });
  click(container.querySelector('.business-mail-thread-row')); await flush(); await flush();
  const latest = () => container.querySelector('[data-mail-id="m3"]');
  click([...latest().querySelectorAll('button')].find(b => b.textContent === ui('답장'))); await flush();
  const composer = () => container.querySelector('.business-mail-composer');
  assert.equal(composer().querySelector(`[aria-label="${ui('받는 사람')}"]`).value, 'billing@example.com', 'Reply-To wins over From');
  assert.equal(composer().querySelector(`[aria-label="${ui('메일 제목')}"]`).value, 'RE: Invoice');
  assert.match(composer().querySelector(`[aria-label="${ui('메일 본문')}"]`).value, /\n> Thanks, received\./);
  const { api: client } = await import('../src/api.ts');
  const send = client.sendBusinessMail;
  client.sendBusinessMail = async (...args) => { if (fail) { fail = false; calls.push(['sendBusinessMail', ...args]); throw new Error('Network lost'); } return send(...args); };
  t.after(() => { client.sendBusinessMail = send; });
  typeInto(composer().querySelector(`[aria-label="${ui('메일 본문')}"]`), 'Glad it arrived.');
  click(button(composer(), ui('보내기'))); await flush(); await flush();
  assert.match(composer().querySelector('[role="alert"]').textContent, /Network lost/);
  click(button(composer(), ui('보내기'))); await flush(); await flush();
  const sends = calls.filter(c => c[0] === 'sendBusinessMail');
  assert.equal(sends.length, 2); assert.equal(sends[0][2].request_id, sends[1][2].request_id);
  assert.deepEqual({ ...sends[1][2], request_id: 'id' }, { request_id: 'id', from: 'ops@example.com', to: ['billing@example.com'], subject: 'RE: Invoice', text: 'Glad it arrived.', reply_to_message_id: 'm3', confirm: true });
  assert.equal(sends[1][1], 'c1'); assert.equal(Boolean(composer()), false, 'a sent draft closes');
  assert.ok(container.querySelector('[data-mail-id="sent-3"]'), 'the sent reply joins the conversation');

  click([...latest().querySelectorAll('button')].find(b => b.textContent === ui('전체 답장'))); await flush();
  assert.equal(composer().querySelector(`[aria-label="${ui('받는 사람')}"]`).value, 'billing@example.com, vendor@example.com, cc@example.com', 'own addresses are left out');
  click(button(composer(), ui('취소'))); await flush();

  click(latest().querySelector('.business-mail-message-head')); await flush();
  click(container.querySelector('[data-mail-id="m1"] .business-mail-message-head')); await flush();
  click([...container.querySelector('[data-mail-id="m1"]').querySelectorAll('button')].find(b => b.textContent === ui('전달'))); await flush();
  assert.equal(composer().querySelector(`[aria-label="${ui('받는 사람')}"]`).value, '');
  assert.equal(composer().querySelector(`[aria-label="${ui('메일 제목')}"]`).value, 'Fwd: Invoice');
  assert.match(composer().querySelector(`[aria-label="${ui('메일 본문')}"]`).value, new RegExp(`${ui('---------- 전달된 메일 ----------')}[\\s\\S]*Please send the invoice\\.`));
  click(button(composer(), ui('보내기'))); await flush();
  assert.match(composer().querySelector('[role="alert"]').textContent, uiPattern('받는 사람을 입력하세요.'));
  typeInto(composer().querySelector(`[aria-label="${ui('받는 사람')}"]`), 'boss@example.com');
  click(button(composer(), ui('보내기'))); await flush(); await flush();
  const forward = calls.filter(c => c[0] === 'sendBusinessMail').at(-1)[2];
  assert.equal(forward.forward_message_id, 'm1'); assert.equal(forward.reply_to_message_id, undefined); assert.deepEqual(forward.to, ['boss@example.com']);
});

test('conversation helpers: quoted text, subjects, recipients and the sending address', () => {
  assert.deepEqual(splitQuoted('New text\n\n2026년 1월 1일 (목) 오전 9:00, Kim <kim@example.com>님이 작성:\n> old'), { body: 'New text', quoted: '2026년 1월 1일 (목) 오전 9:00, Kim <kim@example.com>님이 작성:\n> old' });
  assert.equal(splitQuoted('Answer\n________________\nFrom: a@example.com\nSent: today').body, 'Answer');
  assert.equal(splitQuoted('Answer\nFrom: a@example.com\nSent: today').body, 'Answer');
  assert.equal(splitQuoted('Answer\n-----Original Message-----\nold').body, 'Answer');
  assert.equal(splitQuoted('Answer\nKim wrote:\n> old\n>\n> older\n').body, 'Answer');
  assert.equal(splitQuoted('> only quoted').quoted, '', 'nothing new means nothing is hidden');
  assert.equal(splitQuoted('보고서 작성:\n- 1월 매출').quoted, '', 'an ordinary line ending in a colon is not a quote');
  assert.equal(splitQuoted('FYI\nOn Mon, a@example.com wrote:\n> x', 'Fwd: Plan').quoted, '', 'forwards keep their content');
  assert.equal(composeSubject('Re: Plan', 'reply'), 'Re: Plan'); assert.equal(composeSubject('답장: 계획', 'reply'), '답장: 계획');
  assert.equal(composeSubject('Plan', 'reply'), 'Re: Plan'); assert.equal(composeSubject('FW: Plan', 'forward'), 'FW: Plan'); assert.equal(composeSubject('Plan', 'forward'), 'Fwd: Plan');
  const own = new Set(['ops@example.com']);
  const inbound = { ...message, to: ['ops@example.com', 'Team@Example.com', 'team@example.com'] };
  assert.deepEqual(composeRecipients(inbound, 'reply', own), ['vendor@example.com']);
  assert.deepEqual(composeRecipients(inbound, 'reply_all', own), ['vendor@example.com', 'Team@Example.com']);
  assert.deepEqual(composeRecipients({ ...message, direction: 'outbound', from: 'ops@example.com', to: ['a@example.com'] }, 'reply', own), ['a@example.com']);
  assert.deepEqual(composeRecipients(inbound, 'forward', own), []);
  assert.equal(composeFrom({ ...message, to: ['support@example.com'] }, { config: { addresses: ['ops@example.com', 'Support@example.com'] } }), 'Support@example.com');
  assert.equal(composeFrom({ ...message, to: ['other@example.com'] }, { config: { addresses: ['ops@example.com', 'sales@example.com'] }, automation: { from: 'sales@example.com' } }), 'sales@example.com');
  assert.deepEqual(parseRecipients('a@example.com, b@example.com; A@example.com\nc@example.com'), ['a@example.com', 'b@example.com', 'c@example.com']);
  assert.deepEqual([...defaultExpanded([{ ...message, id: 'a', confirmed: true }, { ...message, id: 'b' }, { ...message, id: 'c', confirmed: true }], 'a')].sort(), ['a', 'b', 'c']);
});

test('connection settings preserve the cursor-bound server and let the user pause collection', async t => {
  const { container, calls } = await render(t, { entry: '/business/mail?connections=1' });
  click(button(container, ui("설정"))); await flush();
  const dialog = container.querySelector('[role="dialog"]');
  assert.equal(Boolean(dialog), true);
  assert.equal([...dialog.querySelectorAll('input')].find(n => n.value === 'imap.example.com').disabled, true);
  const enabled = [...dialog.querySelectorAll('input[type="checkbox"]')].at(-1);
  click(enabled); click(button(container, ui("연결 저장"))); await flush(); await flush();
  const saved = calls.find(c => c[0] === 'configureBusinessMail')[1]; assert.equal(saved.enabled, false); assert.equal(saved.id, 'c1'); assert.equal(saved.revision, 0);
});

test('missing business permission does not fetch private mail', async t => {
  const { container, calls } = await render(t, { permissions: [] });
  assert.match(container.textContent, uiPattern("비즈니스 메일을 보려면 business.manage 권한이 필요합니다."));
  assert.equal(calls.some(c => c[0] === 'listBusinessMail' || c[0] === 'listBusinessMailThreads'), false);
});

test('review mode saves the entered runtime and objective with one connection save', async t => {
  const { container, calls } = await render(t, { entry: '/business/mail?connections=1' });
  click(button(container, ui("설정"))); await flush();
  const dialog = container.querySelector('[role="dialog"]');
  const mode = dialog.querySelector(`[aria-label="${ui("답장 모드")}"]`);
  run(() => { mode.value = 'review'; mode.dispatchEvent(new window.Event('change', { bubbles: true })); }); await flush();
  const template = dialog.querySelector(`[aria-label="${ui("Agent 템플릿 (선택 사항)")}"]`);
  assert.ok(template, 'runtime fields are immediately available in review mode');
  run(() => { template.value = 'mail-template'; template.dispatchEvent(new window.Event('change', { bubbles: true })); }); await flush();
  const workingDir = dialog.querySelector('input[placeholder="/path/to/repo"]'); assert.ok(workingDir);
  typeInto(workingDir, '/srv/mail');
  typeInto(dialog.querySelector(`[aria-label="${ui("업무 목적 · 답장 기준")}"]`), '제품 문의에 답장 초안 작성');
  click(button(container, ui("연결 저장"))); await flush(); await flush();
  const validated = calls.find(c => c[0] === 'validateRuntimeSpec'); assert.ok(validated);
  assert.equal(validated[1], 'a1');
  const saved = calls.find(c => c[0] === 'configureBusinessMail')?.[1]; assert.ok(saved);
  assert.equal(saved.automation.mode, 'review');
  assert.equal(saved.automation.objective, '제품 문의에 답장 초안 작성');
  assert.equal(saved.automation.agent_runtime.manager_agent_id, 'mail-host');
  assert.equal(saved.automation.agent_runtime.cli, 'codex');
  assert.equal(saved.automation.agent_runtime.working_dir, '/srv/mail');
  assert.equal(Boolean(container.querySelector('[role="dialog"]')), false);
});

test('missing reply requirements remain visible next to save without discarding edits', async t => {
  const { container, calls } = await render(t, { entry: '/business/mail?connections=1' });
  click(button(container, ui("설정"))); await flush();
  const dialog = container.querySelector('[role="dialog"]');
  const mode = dialog.querySelector(`[aria-label="${ui("답장 모드")}"]`);
  run(() => { mode.value = 'review'; mode.dispatchEvent(new window.Event('change', { bubbles: true })); }); await flush();
  click(button(container, ui("연결 저장"))); await flush();
  let alert = dialog.querySelector('[role="alert"]'); assert.ok(alert);
  assert.match(alert.textContent, uiPattern("업무 목적 · 답장 기준을 입력하세요."));
  assert.ok(alert.closest('[data-testid="mail-connection-save"]'), 'save errors stay beside the action, outside the scrolled form');
  typeInto(dialog.querySelector(`[aria-label="${ui("업무 목적 · 답장 기준")}"]`), '문의 초안');
  click(button(container, ui("연결 저장"))); await flush();
  alert = dialog.querySelector('[role="alert"]');
  assert.match(alert.textContent, uiPattern("담당 에이전트의 Host·CLI·작업 폴더를 설정하세요."));
  assert.equal(dialog.querySelector(`[aria-label="${ui("업무 목적 · 답장 기준")}"]`).value, '문의 초안');
  assert.equal(calls.some(c => c[0] === 'configureBusinessMail'), false);
});

test('a notification link opens its message; live receipt refreshes mail and announces only once', async t => {
  const { container, calls, FakeEventSource } = await render(t, { entry: '/business/mail?message=m1', notifications: true });
  assert.ok(container.querySelector('.business-mail-body'));
  assert.ok(calls.some(c => c[0] === 'getBusinessMailThread' && c[1] === 'm1'));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1600)); });
  const before = calls.filter(c => c[0] === 'listBusinessMailThreads').length;
  const event = { account_id: 'a1', message_id: 'm1', action: 'received', notification_id: 'task:received', title: '새 메일 · 운영', body: '고유한 수신 알림 제목' };
  act(() => FakeEventSource.instances.at(-1).emit('business_mail_update', event)); await flush();
  act(() => FakeEventSource.instances.at(-1).emit('business_mail_update', event)); await flush();
  assert.ok(calls.filter(c => c[0] === 'listBusinessMailThreads').length > before);
  assert.equal(document.body.textContent.split('고유한 수신 알림 제목').length - 1, 1);
});

test('review drafts must be saved before approval; approval sends the exact displayed revision', async t => {
  let reply = { id: 'reply1', message_id: 'm1', connection_id: 'c1', status: 'review', mode: 'review', objective: '제품 문의 답변',
    from: 'ops@example.com', to: 'vendor@example.com', subject: 'Re: Invoice', text: '에이전트 초안', note: '', revision: 3, last_error: '', room_id: '', notification_state: 'sent' };
  const { container, calls } = await render(t, { entry: '/business/mail?message=m1', mails: [{ ...message, reply: { id: 'reply1', status: 'review' } }], stubs: {
    getBusinessMailReply: async () => reply,
    editBusinessMailReply: async (_id, input) => (reply = { ...reply, ...input, revision: reply.revision + 1 }),
    decideBusinessMailReply: async (_id, _input) => (reply = { ...reply, status: 'sent', revision: reply.revision + 1 }),
  } });
  const textarea = container.querySelector('.business-mail-reply textarea'); assert.ok(textarea);
  typeInto(textarea, '검토하고 수정한 답장');
  assert.equal(button(container, ui("승인하고 발송")).disabled, true);
  click(button(container, ui("초안 저장"))); await flush(); await flush();
  assert.equal(button(container, ui("승인하고 발송")).disabled, false);
  click(button(container, ui("승인하고 발송"))); await flush(); await flush();
  assert.deepEqual(calls.find(c => c[0] === 'decideBusinessMailReply').slice(1), ['reply1', { revision: 4, action: 'approve' }]);
  assert.match(container.querySelector('.business-mail-reply').textContent, uiPattern("발송 접수"));
});
