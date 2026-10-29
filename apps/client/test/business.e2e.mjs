// Real browser layout and navigation; external services and authentication use fixtures.
import { test, expect } from '@playwright/test';
import { cliCatalog } from '../src/cli/catalog.ts';
import { BUSINESS_TEMPLATE } from '../../server/dist/modules/business/business-template.js';
import { BUSINESS_CONNECTORS } from '../../server/dist/modules/business/connectors/registry.js';
import { TRADEMARK_CONNECTORS } from '../../server/dist/modules/business/connectors/trademark-registry.js';
import { emptyTrademark } from '../src/components/business/trademark.logic.ts';
import { assessSelfService, SELF_SERVICE_VERSION } from '../../server/dist/modules/business/business-self-service.js';

const account = { id: 'business-browser-account', name: 'Personal' };
const company = { id: 'business-browser-company', account_id: account.id, name: 'Orbit Labs LLC', entity_type: 'LLC', country: 'US', jurisdiction: 'Delaware', description: '아이디어를 제품으로, 제품을 지속 가능한 비즈니스로.', campaign_ids: ['campaign-1'], revision: 3 };
const tasks = BUSINESS_TEMPLATE.map((item, i) => ({ id: item.key, account_id: account.id, company_id: company.id, title: item.title, description: item.description, stage: item.stage, status: i < 3 ? 'done' : item.key === 'bank_open' ? 'in_progress' : 'todo', depends_on: item.requires, blocked_by: item.requires.filter(key => !BUSINESS_TEMPLATE.slice(0, 3).some(t => t.key === key)), due_on: item.key === 'bank_open' ? '2026-10-28' : null, owner: item.key === 'bank_open' ? 'Finance' : '', notes: '', ticket_id: null, ticket: null, position: i }));

async function fixture(page) {
  const errors = [];
  const cashbook = { entries: [], period: null };
  const trademarkState = { cases: [], mail: [], payload: null, sends: 0 };
  const integrationState = { connectors: TRADEMARK_CONNECTORS.map(c => c.descriptor), connections: [], records: [], actions: [], sends: 0 };
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ accountId }) => {
    localStorage.setItem('auth_token', 'browser-fixture-token');
    localStorage.setItem('currentAccountId', accountId);
    window.EventSource = class extends EventTarget { readyState = 1; close() { this.readyState = 2; } };
  }, { accountId: account.id });
  const detail = { company: { ...company, service_choices: {} }, tasks: structuredClone(tasks), connections: [], campaigns: [{ id: 'campaign-1', name: 'Orbit 첫 고객 찾기', goal: '실제 고객의 피드백으로 제품의 다음 단계를 정합니다.', status: 'active', cycle_count: 4 }], events: [
    { id: 'event-1', message: 'EIN 발급과 법인 문서 보관 · 완료', kind: 'task', created_at: '2026-10-23T03:40:00Z' },
    { id: 'event-2', message: '설립 신청 · 서명 · 서류 확인 · 완료', kind: 'task', created_at: '2026-10-22T05:10:00Z' },
    { id: 'event-3', message: 'Orbit Labs LLC의 운영 워크플로를 만들었습니다.', kind: 'company', created_at: '2026-10-20T01:10:00Z' },
  ] };
  const mcpState = { rows: ['doola', 'northwest'].map(provider => ({ provider, status: 'disconnected', connected_at: null, tools_synced_at: null, last_error: '', pending_mode: null, tools: [] })) };
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, '');
    let body = [];
    if (path === '/auth/me') body = { id: 'owner', name: 'Orbit owner', role: 'admin', status: 'active', permissions: [], resolved_permissions: ['business.manage', 'marketing.manage', 'admin.credentials', 'tickets.create'], accounts: [account] };
    else if (path === '/auth/setup-status') body = { needs_setup: false };
    else if (path === '/cli-catalog') body = { clis: cliCatalog() };
    else if (path === '/voice/config') body = { stt: { ready: false }, tts: { ready: false }, wake: { ready: false } };
    else if (path === '/voice/operators') body = { operators: [] };
    else if (path === '/business/companies') body = [company];
    else if (path === '/business/connectors') body = BUSINESS_CONNECTORS.map(c => c.descriptor);
    else if (path === `/business/companies/${company.id}`) body = detail;
    else if (path.endsWith('/self-service/assess')) {
      const input = request.postDataJSON();
      body = { ...assessSelfService(detail.company, input.provider, input.plan, input.answers ?? detail.company.self_service?.[input.provider]?.answers ?? {}), company_revision: detail.company.revision, stale: false };
    }
    else if (path.includes('/services/')) {
      const input = request.postDataJSON(); const stage = path.split('/').at(-1);
      detail.company.service_choices[stage] = { provider: input.provider, plan: input.plan };
      detail.company.self_service = { ...detail.company.self_service, [input.provider]: { answers: input.self_service_answers, version: SELF_SERVICE_VERSION } };
      detail.company.revision++; body = detail.company;
    }
    else if (path.includes('/cashbook/')) {
      const input = request.method() === 'POST' ? request.postDataJSON() : null;
      if (path.endsWith('/entries')) {
        body = { ...input, id: 'entry-browser', reconciled: false, voided: false, void_reason: '' }; cashbook.entries.push(body); detail.company.revision++;
      } else if (path.endsWith('/reconcile')) {
        Object.assign(cashbook.entries[0], { evidence: input.evidence, reconciled: input.reconciled }); detail.company.revision++; body = cashbook.entries[0];
      } else if (path.endsWith('/void')) {
        Object.assign(cashbook.entries[0], { voided: true, void_reason: input.reason }); detail.company.revision++; body = cashbook.entries[0];
      } else if (path.endsWith('/close')) {
        cashbook.period = { ...input, month: path.split('/').at(-2), closed: true }; detail.company.revision++; body = cashbook.period;
      } else if (path.endsWith('/reopen')) {
        cashbook.period.closed = false; cashbook.period.reopen_reason = input.reason; detail.company.revision++; body = cashbook.period;
      } else {
        const month = path.split('/').at(-1); const entries = cashbook.entries.filter(e => e.date.startsWith(month)); const active = entries.filter(e => !e.voided);
        const total = active.reduce((sum, e) => sum + e.amount_minor, 0);
        body = { month, currency: 'USD', company_revision: detail.company.revision, entries, period: cashbook.period, summary: { inflow_minor: total, outflow_minor: 0, net_minor: total, operating_in_minor: total, operating_out_minor: 0, active_count: active.length, unreconciled_count: active.filter(e => !e.reconciled).length } };
      }
    }
    else if (path === '/business/credentials') body = [{ id: 'resend-fixture-key', provider: 'resend', name: 'Legal mail' }, { id: 'tsdr-fixture-key', provider: 'uspto_tsdr', name: 'TSDR read key' }];
    else if (path.endsWith('/trademarks/trademark-fixture/integrations')) {
      if (request.method() === 'POST') {
        const input = request.postDataJSON(); body = { ...input, id: `${input.provider}-fixture`, status: 'configured', ready: true, revision: 0 };
        integrationState.connections.push(body);
      } else body = integrationState;
    }
    else if (path.endsWith('/integrations/uspto_tsdr-fixture/sync')) {
      integrationState.records = [{ id: 'official-status', integration_id: 'uspto_tsdr-fixture', source_id: 'status:12345678', kind: 'status', title: 'Orbit official status', status: 'LIVE', text: 'Application is pending examination.', details: { serial_number: '12345678' }, url: 'https://tsdr.uspto.gov/#caseNumber=12345678' }]; body = { success: true };
    }
    else if (path.endsWith('/integrations/doc-fixture/options')) body = { roles: [{ role: 'Client', name: '', email: '' }], documents: ['Engagement agreement.pdf'] };
    else if (path.endsWith('/integrations/doc-fixture/actions')) {
      const input = request.postDataJSON(); body = { id: 'contract-fixture', integration_id: 'doc-fixture', kind: 'contract', status: 'draft', title: input.payload.subject, payload_digest: 'b'.repeat(64), revision: 0, review: { ...input.payload, template_name: 'Counsel approved terms', documents: ['Engagement agreement.pdf'] } }; integrationState.actions = [body];
    }
    else if (path.endsWith('/integrations/actions/contract-fixture/document')) {
      await route.fulfill({ status: 200, contentType: 'application/pdf', body: '%PDF-1.4\nfixture-preview' }); return;
    }
    else if (path.endsWith('/integrations/actions/contract-fixture/send')) {
      expect(request.postDataJSON()).toEqual({ confirm: true, revision: 0, payload_digest: 'b'.repeat(64) }); integrationState.sends++;
      integrationState.actions[0] = { ...integrationState.actions[0], status: 'sent', external_id: 'envelope-fixture', external_status: 'completed', revision: 2 }; body = integrationState.actions[0];
    }
    else if (path.endsWith('/integrations/actions/contract-fixture')) body = integrationState.actions[0];
    else if (path === `/business/companies/${company.id}/trademarks`) {
      if (request.method() === 'POST') {
        body = { ...emptyTrademark(company.name), ...request.postDataJSON(), id: 'trademark-fixture', company_id: company.id, account_id: company.account_id, revision: 0 };
        trademarkState.cases.push(body);
      } else body = trademarkState;
    }
    else if (path.endsWith('/trademarks/trademark-fixture/draft')) body = { to: trademarkState.cases[0].attorney_email, subject: 'Orbit trademark engagement inquiry', text: 'Please send an itemized quote and engagement agreement for review. This does not authorize payment or filing.' };
    else if (path.endsWith('/trademarks/trademark-fixture/mail') && request.method() === 'POST') {
      trademarkState.payload = request.postDataJSON().payload;
      body = { id: 'trademark-mail-fixture', trademark_id: 'trademark-fixture', company_id: company.id, provider: 'resend', credential_id: 'resend-fixture-key', status: 'draft', revision: 0, payload_digest: 'a'.repeat(64), subject: trademarkState.payload.subject, to: trademarkState.payload.to, created_at: new Date().toISOString(), first_attempted_at: null, last_error: '' };
      trademarkState.mail = [body];
    }
    else if (path.endsWith('/mail/trademark-mail-fixture')) body = { mail: trademarkState.mail[0], payload: trademarkState.payload };
    else if (path.endsWith('/mail/trademark-mail-fixture/send')) {
      expect(request.postDataJSON()).toEqual({ revision: 0, payload_digest: 'a'.repeat(64), confirm: true }); trademarkState.sends++;
      trademarkState.mail[0] = { ...trademarkState.mail[0], status: 'sent', provider_message_id: 'resend-browser-fixture', delivery_status: 'accepted', revision: 2 }; body = trademarkState.mail[0];
    }
    else if (path.endsWith('/mail/trademark-mail-fixture/delivery')) { trademarkState.mail[0].delivery_status = 'delivered'; body = trademarkState.mail[0]; }
    else if (path === `/business/companies/${company.id}/mcp`) body = mcpState.rows;
    else if (path.endsWith('/mcp/northwest/authorize')) body = { url: 'https://id.northwestregisteredagent.com/auth?client_id=mcp-connector', mode: 'paste', redirect_uri: 'http://localhost:47913/awb/oauth/callback' };
    else if (path.endsWith('/mcp/northwest/complete')) {
      expect(request.postDataJSON().callback_url).toMatch(/^http:\/\/localhost:47913\/awb\/oauth\/callback\?/);
      mcpState.rows[1] = { ...mcpState.rows[1], status: 'connected', connected_at: '2026-10-29T00:00:00Z', tools: [
        { name: 'v2_client__get_companies_tool', title: '', description: 'List companies on the Northwest account', read_only: true, owner_only: false },
        { name: 'v2_client__add_formation_to_cart_tool', title: '', description: 'Add a formation filing to the cart', read_only: false, owner_only: false },
        { name: 'v2_client__checkout_cart_tool', title: '', description: 'Charge the saved payment method', read_only: false, owner_only: true }] };
      body = { company_id: company.id, provider: 'northwest' };
    }
    else if (path.endsWith('/mcp/northwest/tools/refresh')) body = { count: 3 };
    else if (path === '/marketing/campaigns') body = detail.campaigns;
    else if (path === '/marketing/inbox') body = { total: 0, campaigns: [] };
    else if (path === '/accounts') body = [account];
    else if (path === `/accounts/${account.id}`) body = account;
    else if (path.includes('/unread') || path.endsWith('counts') || path.includes('/mentions')) body = { count: 0, total: 0, items: [], perRoom: {}, perTicket: {} };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return { errors, trademarkState, integrationState, cashbook, mcpState };
}

for (const width of [1440, 390, 320]) {
  test(`Automation mail unified filters and confirmation fit ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { errors } = await fixture(page);
    const connection = { id: 'mail-1', account_id: account.id, company_id: company.id, name: '운영 메일 · NAS', provider: 'smtp_imap', purpose: 'operations', credential_id: 'mail-key', enabled: true, revision: 0, interval_minutes: 5, status: 'connected', synced_at: '2026-10-24T01:00:00Z', busy: false, last_error: '', config: { addresses: ['ops@example.com', 'support@example.com'], imap: { host: 'mail.example.com', port: 993, username: 'ops@example.com', tls: 'implicit', folder: 'INBOX' }, smtp: { host: 'mail.example.com', port: 587, username: 'ops@example.com', tls: 'starttls' } } };
    const message = { id: 'mail-message-1', connection_id: connection.id, direction: 'inbound', status: 'received', from: 'vendor@example.com', to: ['ops@example.com'], subject: '10월 운영 정산 확인 요청', text: '정산 내역 확인을 요청드립니다.\n<img src="https://tracker.example.com/private">', date: '2026-10-24T00:00:00Z', confirmed: false, revision: 0, note: '', attachments: [{ name: 'invoice.pdf', size: 1200 }], last_error: '' };
    const filters = []; const sends = [];
    const thread = () => ({ id: 'thread-1', latest_id: message.id, subject: message.subject, preview: '정산 내역 확인을 요청드립니다.', last_at: message.date, count: 1, inbound: 1, outbound: 0,
      unconfirmed: message.confirmed ? 0 : 1, attachments: 1, senders: [message.from], connection_ids: [connection.id], statuses: [], replies: [] });
    await page.route('**/api/business/mail/**', async route => {
      const url = new URL(route.request().url()); const path = url.pathname; let body;
      if (path.endsWith('/connections')) body = { connections: [connection], connectors: [{ id: 'smtp_imap', name: 'SMTP · IMAP', note: '메일 서버의 비밀번호 또는 앱 비밀번호로 연결합니다.' }, { id: 'jmap', name: 'JMAP' }], credentials: [{ id: 'mail-key', name: 'NAS Mail', account_id: account.id }] };
      else if (path.endsWith('/confirm')) { Object.assign(message, route.request().postDataJSON(), { revision: 1, confirmed_at: new Date().toISOString() }); body = message; }
      else if (path.endsWith('/messages')) {
        filters.push(url.search);
        body = url.searchParams.get('view') === 'threads' ? { view: 'threads', threads: [thread()], total: 1, offset: 0, limit: 50 } : { messages: [message], total: 1, offset: 0, limit: 50 };
      }
      else if (path.endsWith('/reply')) body = null;
      else if (path.endsWith('/send')) { sends.push(route.request().postDataJSON()); body = { ...message, id: 'mail-sent', direction: 'outbound', status: 'accepted' }; }
      else body = url.searchParams.get('thread') === '1' ? { ...message, thread: { id: 'thread-1', total: 1, messages: [message] } } : message;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto('/business/mail');
    await expect(page.getByRole('heading', { name: '비즈니스 메일', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '필터', exact: true }).click();
    await page.getByLabel('모든 업무 용도', { exact: true }).selectOption('operations');
    await expect.poll(() => filters.at(-1)).toContain('purpose=operations');
    await expect.poll(() => filters.at(-1)).toContain('view=threads');
    await expect(page.locator('.business-mail-thread-row')).toContainText('vendor@example.com');
    await page.screenshot({ path: `/tmp/awb-mail-threads-${width}.png`, fullPage: true });
    await page.locator('.business-mail-row').click();
    const narrow = width < 800;
    // Narrow screens swap the list for the open conversation and offer a way back.
    await expect(page.getByRole('region', { name: '통합 메일 목록' })).toBeVisible({ visible: !narrow });
    await expect(page.getByRole('button', { name: '← 목록으로', exact: true })).toBeVisible({ visible: narrow });
    await expect(page.locator('.business-mail-message .business-mail-body')).toContainText('<img');
    await expect(page.locator('.business-mail-body img')).toHaveCount(0);
    await page.getByLabel('처리 메모', { exact: true }).fill('회계 기록과 대조 완료');
    await page.getByRole('button', { name: '확인 완료', exact: true }).click();
    await expect(page.getByRole('button', { name: '미확인으로 되돌리기' })).toBeVisible();
    await page.getByRole('button', { name: '답장', exact: true }).click();
    const composer = page.getByRole('region', { name: '답장', exact: true });
    await expect(composer.getByLabel('받는 사람', { exact: true })).toHaveValue('vendor@example.com');
    await composer.getByLabel('메일 본문', { exact: true }).fill('확인했습니다. 이번 주 안에 정산하겠습니다.');
    await expect(composer.getByRole('button', { name: '보내기', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: `/tmp/awb-mail-${width}.png`, fullPage: true });
    await composer.getByRole('button', { name: '보내기', exact: true }).click();
    await expect.poll(() => sends.length).toBe(1);
    expect(sends[0]).toMatchObject({ from: 'ops@example.com', to: ['vendor@example.com'], subject: 'Re: 10월 운영 정산 확인 요청', reply_to_message_id: message.id, confirm: true });
    await expect(composer).toHaveCount(0);
    if (narrow) {
      await page.getByRole('button', { name: '← 목록으로', exact: true }).click();
      await expect(page.getByRole('region', { name: '통합 메일 목록' })).toBeVisible();
    }
    await page.getByRole('button', { name: '메일 연결 추가', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect.poll(() => page.getByRole('dialog').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await page.getByRole('button', { name: '취소', exact: true }).click();
    await page.getByRole('button', { name: '비즈니스 메일 메뉴', exact: true }).click();
    await page.getByRole('button', { name: /연결 관리/ }).click();
    await page.getByRole('button', { name: '설정', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('답장 모드', { exact: true }).selectOption('review');
    await expect(dialog.getByLabel('Agent 템플릿 (선택 사항)', { exact: true })).toHaveCount(1);
    await expect.poll(() => dialog.locator('fieldset').evaluateAll(nodes => nodes.every(node => node.scrollHeight <= node.clientHeight + 1))).toBe(true);
    await dialog.getByRole('button', { name: '연결 저장', exact: true }).click();
    const saveError = dialog.getByTestId('mail-connection-save').getByRole('alert');
    await expect(saveError).toContainText('업무 목적');
    await expect(saveError).toBeInViewport();
    await expect(dialog.getByRole('button', { name: '연결 저장', exact: true })).toBeInViewport();
    await expect.poll(() => dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await dialog.screenshot({ path: `/tmp/awb-mail-review-settings-${width}.png` });
    expect(errors).toEqual([]);
  });

  test(`Overseas DIY conditions and cashbook through reconciliation, close and correction at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { errors, cashbook } = await fixture(page);
    await page.goto(`/business/connectors?company=${company.id}`);
    await page.getByLabel('연동 방식', { exact: true }).selectOption('manual');
    await expect(page.locator('.business-connector-card')).toHaveCount(2);
    const formation = page.getByRole('article', { name: '직접 LLC 설립 서비스', exact: true });
    await formation.getByLabel('직접 LLC 설립 가격 플랜').selectOption('DE');
    await formation.getByRole('button', { name: '조건 확인 · 직접 선택' }).click();
    let dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: '조건을 확인하고 직접 처리 선택' })).toBeDisabled();
    for (const key of ['operator_abroad', 'standard_llc', 'name_checked', 'registered_agent', 'authorized_filer', 'compliance_plan', 'foreign_owned', 'residence_reviewed']) await dialog.locator(`input[name="${key}"]`).nth(0).check();
    for (const key of ['principal_us', 'responsible_tax_id']) await dialog.locator(`input[name="${key}"]`).nth(1).check();
    await expect(dialog).toContainText('IRS 전화·팩스·우편');
    await expect(dialog).toContainText('전자신고 대신 지정 팩스·우편');
    await expect(dialog.getByRole('button', { name: '조건을 확인하고 직접 처리 선택' })).toBeEnabled();
    const sizes = await dialog.evaluate(el => [el, ...el.querySelectorAll('.business-self-questions, .business-residency-grid')].map(n => [n.scrollWidth, n.clientWidth]));
    expect(sizes.every(([scroll, client]) => scroll <= client + 1)).toBe(true);
    await dialog.screenshot({ path: `/tmp/awb-diy-conditions-${width}.png` });
    await dialog.getByRole('button', { name: '조건을 확인하고 직접 처리 선택' }).click();
    await expect(page.getByRole('region', { name: '직접 처리 진행 안내' })).toBeVisible();
    await page.getByRole('group', { name: '운영 영역' }).getByRole('button', { name: /회계/ }).click();
    const book = page.getByRole('region', { name: '직접 회계 장부' });
    await book.getByRole('button', { name: '직접 회계 선택' }).click();
    dialog = page.getByRole('dialog');
    for (const key of ['operator_abroad', 'single_usd_account', 'settled_only', 'evidence_plan', 'separate_tax_filing', 'foreign_owned', 'residence_reviewed']) await dialog.locator(`input[name="${key}"]`).nth(0).check();
    await dialog.locator('input[name="complex_activity"]').nth(1).check();
    await dialog.getByRole('button', { name: '조건을 확인하고 직접 처리 선택' }).click();
    await expect(dialog).toHaveCount(0);
    await book.getByLabel('장부 월', { exact: true }).fill('2020-01');
    await book.getByRole('button', { name: '입출금 기록', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('금액 (USD)', { exact: true }).fill('10.29');
    await dialog.getByLabel('상대방 · 거래 용도').fill('첫 고객 입금');
    await dialog.getByLabel('증빙 위치 · 참조').fill('receipt-01');
    await dialog.getByRole('button', { name: '확인하고 저장' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(book.getByRole('button', { name: '잔액 확인 · 월 마감' })).toBeDisabled();
    await book.getByRole('button', { name: '증빙 · 대사', exact: true }).click();
    dialog = page.getByRole('dialog'); await dialog.getByRole('checkbox').check(); await dialog.getByRole('button', { name: '확인하고 저장' }).click();
    await expect(dialog).toHaveCount(0);
    await book.getByRole('button', { name: '잔액 확인 · 월 마감' }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('은행 기초 잔액 (USD)', { exact: true }).fill('0');
    await dialog.getByLabel('은행 기말 잔액 (USD)', { exact: true }).fill('10.28');
    await dialog.getByLabel('은행 명세서 위치 · 참조').fill('bank-january');
    await dialog.getByRole('checkbox').check(); await expect(dialog.getByRole('button', { name: '확인하고 저장' })).toBeDisabled();
    await dialog.getByLabel('은행 기말 잔액 (USD)', { exact: true }).fill('10.29');
    await dialog.getByRole('button', { name: '확인하고 저장' }).click();
    await expect(book).toContainText('내부 월 마감 완료');
    await expect(book.getByRole('button', { name: '입출금 기록', exact: true })).toBeDisabled();
    expect(cashbook.entries[0].amount_minor).toBe(1029);
    await book.screenshot({ path: `/tmp/awb-diy-cashbook-${width}.png` });
    const downloadEvent = page.waitForEvent('download'); await book.getByRole('button', { name: 'CSV 내보내기' }).click(); expect((await downloadEvent).suggestedFilename()).toContain('2020-01.csv');
    await book.getByRole('button', { name: '마감 재개', exact: true }).click();
    dialog = page.getByRole('dialog'); await dialog.getByLabel('처리 사유').fill('중복 거래 정정'); await dialog.getByRole('button', { name: '확인하고 저장' }).click();
    await expect(dialog).toHaveCount(0);
    await book.getByRole('button', { name: '취소', exact: true }).click();
    dialog = page.getByRole('dialog'); await dialog.getByLabel('처리 사유').fill('중복 거래'); await dialog.getByRole('button', { name: '확인하고 저장' }).click();
    await expect(book).toContainText('취소: 중복 거래');
    expect(cashbook.entries[0].voided).toBe(true); expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  });

  test(`MCP OAuth link selects the exact trademark and connection at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { errors, trademarkState, integrationState } = await fixture(page);
    const base = { ...emptyTrademark(company.name), company_id: company.id, account_id: company.account_id, revision: 0 };
    trademarkState.cases.push({ ...base, id: 'first-trademark', mark: 'First brand' }, { ...base, id: 'trademark-fixture', mark: 'OAuth target' });
    integrationState.connections.push({ id: 'gmail-fixture', provider: 'gmail', status: 'configured', ready: false, auto_sync: false, interval_minutes: 15, config: {}, revision: 0 });
    let authorizations = 0;
    await page.route('**/integrations/gmail-fixture/authorize', async route => { authorizations++; await route.fulfill({ json: { url: 'https://accounts.google.com/oauth-fixture' } }); });
    await page.route('https://accounts.google.com/oauth-fixture', route => route.fulfill({ contentType: 'text/html', body: '<p>Provider consent fixture</p>' }));
    await page.goto(`/business/operations?company=${company.id}&stage=trademark&trademark=trademark-fixture&authorize=gmail-fixture`);
    await expect(page.getByRole('button', { name: 'OAuth target', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const gmail = page.getByRole('article', { name: 'Gmail 커넥터' });
    await expect(gmail).toHaveClass(/business-integration-authorize/);
    await expect(gmail).toContainText('에이전트가 준비한 연결');
    expect(authorizations).toBe(0);
    await gmail.getByRole('button', { name: '서비스 로그인 연결' }).click();
    await expect(page).toHaveURL('https://accounts.google.com/oauth-fixture');
    expect(authorizations).toBe(1); expect(errors).toEqual([]);
  });

  test(`Trademark integration setup, official records and reviewed contracts at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { errors, trademarkState, integrationState } = await fixture(page);
    trademarkState.cases.push({ ...emptyTrademark(company.name), id: 'trademark-fixture', company_id: company.id, account_id: company.account_id, revision: 0, mark: 'Orbit', serial_number: '12345678', attorney_email: 'counsel@example.invalid' });
    integrationState.connections.push({ id: 'doc-fixture', provider: 'docusign', status: 'connected', ready: true, auto_sync: true, interval_minutes: 15, identity: { name: 'Orbit legal' }, config: {}, revision: 0 });
    await page.goto(`/business/operations?company=${company.id}&stage=trademark`);
    const integrations = page.getByRole('region', { name: '상표 자동화 커넥터' });
    await expect(integrations.locator('article')).toHaveCount(6);
    const tsdr = integrations.getByRole('article', { name: 'USPTO · TSDR 커넥터' });
    await tsdr.getByRole('button', { name: '연결 설정', exact: true }).click();
    const setup = page.getByRole('dialog');
    await setup.getByLabel('연동 credential', { exact: true }).selectOption('tsdr-fixture-key');
    await setup.getByLabel('자동 수집 간격', { exact: true }).selectOption('60');
    await setup.getByRole('button', { name: '연결 설정 저장' }).click();
    await expect(setup).toHaveCount(0);
    await expect(tsdr).toContainText('60분마다 자동 수집');
    await tsdr.getByRole('button', { name: '지금 수집' }).click();
    await integrations.getByText('Orbit official status', { exact: false }).click();
    await expect(integrations).toContainText('Application is pending examination.');
    await integrations.getByRole('article', { name: 'DocuSign 커넥터' }).getByRole('button', { name: '계약 서명 요청' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Client 이름', { exact: true }).fill('Orbit owner');
    await dialog.getByLabel('Client 이메일', { exact: true }).fill('owner@example.invalid');
    await dialog.getByRole('button', { name: '원문 저장 · 발송 전 검토' }).click();
    await expect(dialog).toContainText('Counsel approved terms');
    await expect(dialog.getByRole('button', { name: '검토한 요청 실제 발송' })).toBeDisabled();
    const previewPromise = page.waitForEvent('download'); await dialog.getByRole('button', { name: '검토 문서 1', exact: false }).click();
    expect((await previewPromise).suggestedFilename()).toBe('agreement-review-1.pdf');
    const widths = await page.evaluate(() => [document.documentElement, ...document.querySelectorAll('.business-integrations, .business-trademark-automation-grid, .awb-dialog')].map(el => ({ client: el.clientWidth, scroll: el.scrollWidth })));
    for (const result of widths) expect(result.scroll).toBeLessThanOrEqual(result.client + 1);
    await dialog.screenshot({ path: `/tmp/awb-trademark-contract-${width}.png` });
    expect(integrationState.sends).toBe(0);
    await dialog.getByRole('checkbox').check(); await dialog.getByRole('button', { name: '검토한 요청 실제 발송' }).click();
    await expect(dialog).toContainText('envelope-fixture'); expect(integrationState.sends).toBe(1);
    const signedPromise = page.waitForEvent('download'); await dialog.getByRole('button', { name: '완료된 서명본 다운로드' }).click();
    expect((await signedPromise).suggestedFilename()).toBe('signed-agreement.pdf');
    await dialog.getByRole('button', { name: '닫기', exact: true }).click();
    await integrations.screenshot({ path: `/tmp/awb-trademark-integrations-${width}.png` });
    expect(errors).toEqual([]);
  });
}

for (const width of [1440, 390, 320]) {
  test(`Trademark case, attorney mail review and delivery at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const { errors, trademarkState } = await fixture(page);
    await page.goto(`/business/operations?company=${company.id}&stage=trademark`);
    await expect(page.getByRole('region', { name: '상표 출원 관리' })).toBeVisible();
    await page.getByRole('button', { name: '상표 추가', exact: true }).click();
    const form = page.getByRole('dialog', { name: '새 상표 출원 준비' });
    await expect(form.getByLabel('실제 본점 국가 코드', { exact: true })).toHaveValue('');
    await form.getByLabel('상표명 · 로고 식별명', { exact: true }).fill('Orbit');
    await form.getByLabel('실제 본점 국가 코드', { exact: true }).fill('KR');
    await form.getByLabel('검토할 상품류', { exact: true }).fill('9, 42');
    await form.getByLabel('상품 · 서비스', { exact: true }).fill('Software for project planning');
    await form.getByRole('button', { name: '2. 변호사 · 계약' }).click();
    await form.getByLabel('변호사 · 로펌 이름', { exact: true }).fill('US Trademark Counsel');
    await form.getByLabel('변호사 이메일', { exact: true }).fill('counsel@example.invalid');
    await form.getByRole('button', { name: '상표 기록 저장' }).click();
    await expect(form).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Orbit', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '변호사 메일 작성' }).click();
    const mail = page.getByRole('dialog');
    await mail.getByLabel('발신 이메일', { exact: true }).fill('legal@example.invalid');
    await mail.getByLabel('회신 이메일', { exact: true }).fill('owner@example.invalid');
    await mail.getByLabel('Resend 연결 키', { exact: true }).selectOption('resend-fixture-key');
    await mail.getByRole('button', { name: '발송 전 검토' }).click();
    await expect(mail).toContainText('counsel@example.invalid');
    await expect(mail.getByRole('button', { name: '확인한 메일 실제 발송' })).toBeDisabled();
    const widths = await page.evaluate(() => [document.documentElement, ...document.querySelectorAll('.business-page, .business-trademarks, .business-trademark-envelope, .awb-dialog')].map(el => ({ client: el.clientWidth, scroll: el.scrollWidth })));
    for (const result of widths) expect(result.scroll).toBeLessThanOrEqual(result.client + 1);
    await mail.screenshot({ path: `/tmp/awb-trademark-mail-${width}.png` });
    expect(trademarkState.sends).toBe(0);
    await mail.getByRole('checkbox').check();
    await mail.getByRole('button', { name: '확인한 메일 실제 발송' }).click();
    await expect(mail).toContainText('resend-browser-fixture'); expect(trademarkState.sends).toBe(1);
    await mail.getByRole('button', { name: '전달 상태 조회' }).click();
    await expect(mail).toContainText('전달됨');
    await mail.getByRole('button', { name: '닫기', exact: true }).click();
    await page.getByRole('region', { name: '상표 출원 관리' }).screenshot({ path: `/tmp/awb-trademark-case-${width}.png` });
    expect(trademarkState.cases[0].phase).toBe('preparing'); expect(errors).toEqual([]);
  });
}

for (const viewport of [{ width: 1440, height: 1080 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
  test(`Business workflow, connectors and dialogs fit ${viewport.width}px`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const { errors } = await fixture(page);
    await page.goto('/business');
    await expect(page.getByRole('heading', { name: 'Orbit Labs LLC', exact: true })).toBeVisible();
    await expect(page.getByRole('progressbar')).toHaveCount(7);
    await expect(page.locator('.business-stage-card').first()).toContainText('3 / 3 완료');
    await expect(page.getByRole('img', { name: '업무 완료율 14%' })).toBeVisible();
    const fits = async () => {
      const widths = await page.evaluate(() => [document.documentElement, ...document.querySelectorAll('.business-content, .business-page, .business-stage-guide, .business-guide-steps > li')].map(el => ({ width: el.clientWidth, scroll: el.scrollWidth })));
      for (const width of widths) expect(width.scroll).toBeLessThanOrEqual(width.width + 1);
    };
    await fits();
    await page.screenshot({ path: info.outputPath('overview.png'), fullPage: true });
    if (viewport.width === 1440) await page.screenshot({ path: '/tmp/awb-business-overview.png', fullPage: true });
    await page.getByRole('button', { name: '단계별 진행 방법' }).click();
    await expect(page).toHaveURL(/business\/operations.*stage=banking/);
    await expect(page.getByRole('heading', { name: '계좌 · 입출금', exact: true })).toBeVisible();
    const guide = page.getByRole('region', { name: '실제 진행 방법', exact: true });
    await expect(guide.getByRole('link', { name: 'Mercury 열기' })).toHaveAttribute('href', 'https://mercury.com');
    await guide.getByText('연결 전에 알아둘 점 · 공식 진행 안내', { exact: true }).click();
    await expect(guide.getByRole('link', { name: '준비할 서류', exact: true })).toHaveAttribute('href', /support\.mercury\.com/);
    await fits();
    await guide.screenshot({ path: info.outputPath('guide.png') });
    if (viewport.width === 1440 || viewport.width === 390) await guide.screenshot({ path: `/tmp/awb-business-guide-${viewport.width}.png` });
    await page.getByRole('button', { name: '업무 추가', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('textbox', { name: '업무 이름', exact: true })).toBeVisible();
    await fits();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await guide.getByRole('link', { name: '직접 처리 · 서비스 비교' }).click();
    await expect(page).toHaveURL(/business\/connectors\?company=business-browser-company/);
    await expect(page.locator('.business-connector-card')).toHaveCount(BUSINESS_CONNECTORS.length);
    await page.locator('.business-connector-card').filter({ has: page.getByRole('heading', { name: 'Mercury', exact: false }) }).getByRole('button', { name: '조회 연결' }).click();
    await expect(page.getByRole('dialog', { name: 'Mercury 연결' })).toBeVisible();
    await expect(page.getByLabel('연결 환경')).toHaveValue('sandbox');
    await page.getByLabel('연결 키').selectOption('__new__');
    await expect(page.getByLabel('api_token', { exact: true })).toHaveAttribute('type', 'password');
    await page.keyboard.press('Escape');
    await fits();
    await page.screenshot({ path: info.outputPath('connectors.png'), fullPage: true });
    if (viewport.width === 1440) await page.screenshot({ path: '/tmp/awb-business-connectors.png', fullPage: true });
    await page.getByLabel('doola 비교', { exact: true }).check();
    await page.getByLabel('Stripe Atlas 비교', { exact: true }).check();
    await page.getByRole('button', { name: '가격 · 기능 비교', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('$297 / 년');
    await expect(page.getByRole('dialog')).toContainText('$500 / 1회');
    await fits();
    await page.getByRole('dialog').screenshot({ path: `/tmp/awb-business-comparison-${viewport.width}.png` });
    await page.getByRole('button', { name: '비교를 마치고 선택하기' }).click();
    const northwest = page.locator('.business-connector-card').filter({ has: page.getByRole('heading', { name: 'Northwest Registered Agent' }) });
    await northwest.getByRole('button', { name: '계정 연결 (MCP)' }).click();
    const panel = page.getByRole('dialog', { name: 'Northwest Registered Agent 계정 연결 (MCP)' });
    const popup = page.waitForEvent('popup');
    await panel.getByRole('button', { name: 'Northwest Registered Agent 로그인' }).click();
    await (await popup).close();
    await expect(panel.getByRole('button', { name: '연결 완료' })).toBeDisabled();
    await panel.getByLabel('로그인 후 주소', { exact: true }).fill('http://localhost:47913/awb/oauth/callback?state=s&session_state=x&code=c');
    await fits();
    await panel.getByRole('button', { name: '연결 완료' }).click();
    await expect(panel).toContainText('v2_client__checkout_cart_tool');
    await expect(panel).toContainText('소유자 직접 · 결제');
    await panel.screenshot({ path: `/tmp/awb-business-mcp-${viewport.width}.png` });
    await fits();
    expect(errors).toEqual([]);
  });
}
