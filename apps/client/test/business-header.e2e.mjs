// Headers need height, hit-target and clipped-control checks, not just document scrollWidth.
import { test, expect } from '@playwright/test';
import { cliCatalog } from '../src/cli/catalog.ts';
import english from '../src/i18n/locales/en.json' with { type: 'json' };
import korean from '../src/i18n/locales/ko.json' with { type: 'json' };
import japanese from '../src/i18n/locales/ja.json' with { type: 'json' };
import chinese from '../src/i18n/locales/zh-CN.json' with { type: 'json' };
const catalogs = { en: english, ko: korean, ja: japanese, 'zh-CN': chinese };
let activeLocale = 'en';
function ui(key, values = {}) {
  return (catalogs[activeLocale][key] ?? english[key] ?? key).replace(/\{(\w+)\}/g, (slot, name) => Object.hasOwn(values, name) ? String(values[name]) : slot);
}
test.beforeEach(() => { activeLocale = 'en'; });

const account = { id: 'business-header-account', name: 'Personal' };
const longName = '해외에서 운영하는 아주 긴 이름의 비즈니스 International Product and Customer Operations LLC';
const company = { id: 'company-header', name: longName, account_id: account.id, entity_type: 'LLC', country: 'US', jurisdiction: 'WY', description: '', campaign_ids: [], service_choices: {}, revision: 0 };
const runtime = { manager_agent_id: 'host-business', cli: 'codex', model: null, working_dir: '/work/company', folder_scope: 'shared', credential_id: null, cli_runtime_profile: null, runtime_config: { strategy: 'single', permission_mode: 'approve' }, label: 'Formation assistant', role_prompt: '' };
const campaign = { id: 'campaign-header', account_id: account.id, name: longName, status: 'active', capabilities: ['email'], currency: 'USD', cycle_interval_ms: 86400000, cycle_count: 12, limits: {}, payees: [], allowed_domains: [], agent_runtime: null, created_at: '2026-10-25T00:00:00Z', updated_at: '2026-10-25T00:00:00Z' };

async function fixture(page, permissions = ['business.manage', 'marketing.manage']) {
  const errors = []; const requests = [];
  const currentCompany = { ...company, agent_runtime: runtime };
  const task = { id: 'task-header', title: longName, company_id: company.id, account_id: account.id, stage: 'formation', status: 'in_progress', description: '설립 방향을 비교하고 근거와 결과를 기록합니다.', notes: '', owner: 'Owner', due_on: null, depends_on: [], blocked_by: [], ticket_id: 'ticket-header', ticket: { id: 'ticket-header', title: 'Formation research', status: 'in_progress' } };
  const result = { id: 'result-first', kind: 'result', content: 'Initial formation plan with [supporting document](https://example.test/plan)', author: 'Owner', author_type: 'user', revision: 1, created_at: '2026-10-25T01:00:00Z', changes: null, resolves_entry_id: null };
  const journal = { task, company_revision: 1, entries: [result], result, decision: null, open_requests: [], next_before: null, runs: [] };
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(({ accountId, locale }) => {
    localStorage.setItem('awb.locale', locale);
    localStorage.setItem('auth_token', 'header-test'); localStorage.setItem('currentAccountId', accountId);
    window.EventSource = class extends EventTarget { readyState = 1; close() {} };
  }, { accountId: account.id, locale: activeLocale });
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, ''); requests.push(path);
    let body = [];
    if (path === '/auth/me') body = { id: 'owner', name: 'Owner', status: 'active', role: 'user', resolved_permissions: permissions, accounts: [account] };
    else if (path === '/auth/setup-status') body = { needs_setup: false };
    else if (path === '/cli-catalog') body = { clis: cliCatalog() };
    else if (path === '/voice/config') body = { stt: { ready: false }, tts: { ready: false }, wake: { ready: false } };
    else if (path === '/voice/operators') body = { operators: [] };
    else if (path === '/accounts') body = [account];
    else if (path === `/accounts/${account.id}`) body = account;
    else if (path === '/agent-templates/hosts') body = [{ id: runtime.manager_agent_id, name: 'Business Host' }];
    else if (path.startsWith('/agent-manager/hosts/')) body = { manager_agent_id: runtime.manager_agent_id, manager_name: 'Business Host', is_online: true, instance_id: 'instance-business', refreshed_at: new Date().toISOString(), models: { codex: ['gpt-5'] } };
    else if (path === '/runtime-specs/validate') body = { ok: true, spec: runtime };
    else if (path === '/business/companies') body = [currentCompany, { ...company, id: 'company-other', name: 'Second LLC' }];
    else if (path === `/business/companies/${company.id}/tasks/task-header/entries`) {
      const input = route.request().postDataJSON();
      const row = { ...input, id: input.request_id, task_id: task.id, revision: ++journal.company_revision, author: 'Owner', author_type: 'user', created_at: new Date().toISOString(), changes: null };
      journal.entries.unshift(row);
      if (row.kind === 'result' || row.kind === 'decision') journal[row.kind] = row;
      if (row.kind === 'request') journal.open_requests.push(row);
      if (row.kind === 'resolution') journal.open_requests = journal.open_requests.filter(request => request.id !== row.resolves_entry_id);
      body = row;
    }
    else if (path === `/business/companies/${company.id}/formation-work` || path === `/business/companies/${company.id}/tasks/task-header/run`) {
      const input = route.request().postDataJSON();
      const run = { id: input.request_id, task_id: task.id, status: 'queued', agent_runtime: runtime, room_id: 'business-room', question: '', summary: '', last_error: '', created_at: new Date().toISOString() };
      journal.runs.unshift(run); currentCompany.formation_task_id = task.id;
      const entry = { id: input.request_id, task_id: task.id, kind: 'request', content: input.content, revision: ++journal.company_revision, author: 'Owner', author_type: 'user', created_at: new Date().toISOString(), changes: null, resolves_entry_id: null };
      journal.entries.unshift(entry); journal.open_requests.push(entry); body = run;
    }
    else if (path === `/business/companies/${company.id}/tasks/task-header`) body = journal;
    else if (path === '/tickets/ticket-header/comments') body = [{ id: 'comment-header', content: 'Agent research and supporting evidence', author: 'Agent', author_type: 'agent', created_at: '2026-10-25T01:30:00Z', attachments: [] }];
    else if (path.startsWith('/business/companies/') && !path.includes('/cashbook/')) body = { company: currentCompany, tasks: [task], formation_work: journal.runs[0] || null, connections: [], campaigns: [], events: [], formations: [] };
    else if (path.includes('/cashbook/')) body = { month: '2026-10', currency: 'USD', company_revision: 0, entries: [], period: null, summary: { inflow_minor: 0, outflow_minor: 0, net_minor: 0, operating_in_minor: 0, operating_out_minor: 0, active_count: 0, unreconciled_count: 0 } };
    else if (path === '/business/mail/connections') body = { connections: [{ id: 'mail-header', name: longName, config: { addresses: ['ops@example.test'] }, enabled: true, purpose: 'operations' }], connectors: [], credentials: [] };
    else if (path === '/business/mail/messages') body = { messages: [], total: 0, offset: 0, limit: 50 };
    else if (path === '/marketing/campaigns') body = [campaign];
    else if (path === `/marketing/campaigns/${campaign.id}`) body = campaign;
    else if (path.endsWith('/budget')) body = null;
    else if (path === '/marketing/inbox') body = { total: 0, campaigns: [] };
    else if (path === '/marketing/contacts') body = { total: 0, contacts: [] };
    else if (path === '/marketing/contacts/replies') body = { total: 0, replies: [] };
    else if (path === '/marketing/consent-notices/settings') body = { settings: { enabled: false }, counts: {} };
    else if (path.includes('/unread') || path.endsWith('counts') || path.includes('/mentions')) body = { count: 0, total: 0, items: [], perRoom: {}, perTicket: {} };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return { errors, requests, journal };
}

async function expectHeaderFits(page) {
  const header = page.locator('.business-page-heading');
  await expect(header).toBeVisible();
  // Measure a single layout snapshot; the sidebar responds asynchronously to rotation.
  await expect.poll(() => page.evaluate(() => {
    const failures = [];
    const bounds = document.querySelector('.business-shell').getBoundingClientRect();
    const header = document.querySelector('.business-page-heading');
    if (header.getBoundingClientRect().height > 105) failures.push('header too tall');
    if (document.querySelector('.business-topbar').getBoundingClientRect().height > 80) failures.push('navigation too tall');
    for (const control of document.querySelectorAll('.business-nav a, .business-page-heading > .business-heading-actions > button, .business-page-heading .awb-session-menu-trigger, .business-company-picker')) {
      const box = control.getBoundingClientRect();
      if (box.width < 44 || box.height < 44 || box.x < bounds.x || box.right > bounds.right + 1) failures.push(control.getAttribute('aria-label') || control.textContent);
    }
    const title = header.querySelector('h1').getBoundingClientRect();
    const actions = header.querySelector('.business-heading-actions')?.getBoundingClientRect();
    if (actions && title.right > actions.x) failures.push('title overlaps actions');
    for (const node of [document.documentElement, ...document.querySelectorAll('.business-content, .business-page-heading, .business-nav')]) {
      if (node.scrollWidth > node.clientWidth + 1) failures.push(`overflow: ${node.className}`);
    }
    return failures;
  })).toEqual([]);
  for (const control of await page.locator('.business-nav a, .business-page-heading > .business-heading-actions > button, .business-page-heading .awb-session-menu-trigger, .business-company-picker').all()) {
    await expect(control).toBeInViewport();
  }
}

const sizes = [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1024, height: 768 }, { width: 1440, height: 900 }, { width: 667, height: 375 }];
for (const [locale, size] of ['en', 'ko', 'ja', 'zh-CN'].flatMap(locale => (locale === 'en' ? sizes : [sizes[0], sizes[2], sizes[5]]).map(size => [locale, size]))) {
  test(`Business headers keep navigation and actions usable in ${locale} at ${size.width}x${size.height}`, async ({ page }, testInfo) => {
    activeLocale = locale;
    await page.setViewportSize(size);
    const f = await fixture(page);
    for (const [path, title] of [
      ['/business?company=company-header', ui("비즈니스 전체 흐름")],
      ['/business/operations?company=company-header&stage=growth', ui("운영 워크플로")],
      ['/business/operations?company=company-header&stage=formation&task=task-header', longName],
      ['/business/connectors?company=company-header', ui("커넥터")],
      ['/business/mail', ui("비즈니스 메일")],
      ['/marketing', ui('Marketing')],
      ['/marketing/contacts', ui('Marketing Contacts')],
      ['/marketing/campaign-header?tab=audit', longName],
    ]) {
      await page.goto(path);
      await expect(page.locator('.business-page-heading h1')).toHaveText(title);
      if (path.includes('company=') && !path.includes('&task=')) await expect(page.getByLabel(ui("관리할 회사"))).toHaveValue(company.id);
      await expectHeaderFits(page);
      const file = path.split('?')[0].replaceAll('/', '-');
      await page.screenshot({ path: testInfo.outputPath(`${file}.png`) });
      const menu = page.getByRole('button', { name: ui("{0} 메뉴", {0: title}), exact: true });
      await menu.click();
      const panel = page.locator('.business-heading-actions .awb-session-menu-panel');
      await expect(panel).toBeInViewport();
      const shell = await page.locator('.business-shell').boundingBox(); const box = await panel.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(shell.x);
      expect(box.x + box.width).toBeLessThanOrEqual(shell.x + shell.width + 1);
      expect(box.y + box.height).toBeLessThanOrEqual(size.height + 1);
      expect(await panel.evaluate(n => n.scrollWidth <= n.clientWidth + 1)).toBe(true);
      if (path === '/business/mail' || path.includes('/campaign-header')) await page.screenshot({ path: testInfo.outputPath(`${file}-menu.png`) });
      await page.keyboard.press('Escape');
      await expect(menu).toBeFocused();
      await expect(menu).toHaveAttribute('aria-expanded', 'false');
      if (path.includes('/operations') && !path.includes('&task=')) {
        const tabs = page.getByRole('group', { name: ui("운영 영역") });
        const active = tabs.locator('[aria-pressed=true]');
        const tabBounds = await tabs.boundingBox(); const activeBounds = await active.boundingBox();
        expect(tabBounds.height).toBeLessThanOrEqual(60);
        expect(activeBounds.x).toBeGreaterThanOrEqual(tabBounds.x);
        expect(activeBounds.x + activeBounds.width).toBeLessThanOrEqual(tabBounds.x + tabBounds.width + 1);
        await expect(page.locator('.business-operations-heading')).toBeInViewport();
      }
      if (path.includes('&task=')) {
        await page.getByRole('button', { name: ui('에이전트에게 맡기기'), exact: true }).click();
        const dialog = page.getByRole('dialog', { name: ui('에이전트에게 업무 맡기기') });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole('button', { name: ui('이 설정으로 실행'), exact: true })).toBeInViewport();
        await expect(dialog.getByRole('button', { name: ui('이 설정으로 실행'), exact: true })).toBeEnabled();
        await dialog.getByRole('button', { name: ui('취소'), exact: true }).click();
      }
      if (path === '/business/mail') {
        await expect(page.getByRole('region', { name: ui("통합 메일 목록") })).toBeInViewport();
        await page.getByRole('button', { name: ui("필터"), exact: true }).click();
        await page.getByLabel(ui("모든 업무 용도"), { exact: true }).selectOption('accounting');
        await page.getByRole('button', { name: ui('필터') + ' (1)', exact: true }).click();
        await expect(page.getByLabel(ui("모든 업무 용도"), { exact: true })).toBeHidden();
        await expect(page).toHaveURL(/purpose=accounting/);
        await menu.click();
        await page.getByRole('button', { name: ui('연결 관리 (') + '1)', exact: true }).click();
        await expect(page.getByRole('region', { name: ui("메일 연결"), exact: true })).toBeVisible();
        await expect(menu).toHaveAttribute('aria-expanded', 'false');
      }
      if (path.includes('/campaign-header')) {
        await menu.click();
        await panel.getByRole('button', { name: ui("일시정지"), exact: true }).click();
        await expect(page.getByRole('dialog', { name: ui('캠페인 {0}', {0: ui('일시정지')}), exact: true })).toBeVisible();
        await page.getByRole('button', { name: ui("취소"), exact: true }).click();
        await expect(menu).toHaveAttribute('aria-expanded', 'false');
      }
      expect(f.errors).toEqual([]);
    }
  });
}

test('Business stage navigation survives rotation and menus preserve company context', async ({ page }) => {
  const f = await fixture(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/business/operations?company=company-header&stage=growth');
  await expect(page.getByLabel(ui("관리할 회사"))).toHaveValue(company.id);
  for (const size of [{ width: 320, height: 568 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    await expectHeaderFits(page);
    const tabs = page.getByRole('group', { name: ui("운영 영역") });
    await expect.poll(() => tabs.evaluate(n => {
      const a = n.querySelector('[aria-pressed=true]').getBoundingClientRect(); const b = n.getBoundingClientRect();
      return a.left >= b.left && a.right <= b.right + 1;
    })).toBe(true);
  }
  await page.getByRole('navigation', { name: ui("Business 메뉴") }).getByRole('link', { name: ui("커넥터"), exact: true }).click();
  await expect(page).toHaveURL(/company=company-header/);
  await page.getByRole('button', { name: ui('{0} 메뉴', {0: ui('커넥터')}), exact: true }).click();
  const before = f.requests.filter(p => p === '/business/companies/company-header').length;
  await page.getByRole('button', { name: ui("워크플로 새로고침"), exact: true }).click();
  await expect.poll(() => f.requests.filter(p => p === '/business/companies/company-header').length).toBeGreaterThan(before);
  await page.getByRole('button', { name: ui("회사 추가"), exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(f.errors).toEqual([]);
});

test('Marketing-only permissions keep Business navigation and menus scoped', async ({ page }) => {
  const f = await fixture(page, ['marketing.approve_spend']);
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/marketing/campaign-header?tab=audit');
  await expect(page.locator('.business-page-heading h1')).toHaveText(longName);
  await expect(page.getByRole('navigation', { name: ui("Business 메뉴") }).getByRole('link')).toHaveCount(1);
  await page.getByRole('button', { name: ui("{0} 메뉴", {0: longName}), exact: true }).click();
  await expect(page.locator('.business-heading-menu-actions').getByRole('link', { name: ui("← 목록") })).toBeVisible();
  await expect(page.locator('.business-page-heading').getByRole('button', { name: new RegExp([ui('지금 실행'), ui('설정'), ui('삭제')].join('|')) })).toHaveCount(0);
  await page.goto('/marketing');
  await page.getByRole('button', { name: ui('{0} 메뉴', {0: ui('Marketing')}), exact: true }).click();
  await expect(page.locator('.business-heading-menu-info')).toContainText(ui("캠페인 에이전트가 주기마다 채널을 찾고 글 · 메일 · 예산을 제안합니다. 돈 · 외부 발신 · 채널 개설은 사람이 승인합니다."));
  await expect(page.getByRole('button', { name: ui("+ 새 캠페인"), exact: true })).toHaveCount(0);
  expect(f.requests.some(p => p.startsWith('/business/'))).toBe(false);
  expect(f.errors).toEqual([]);
});

test('one business work item keeps original outcomes, revision requests and resolutions together', async ({ page }) => {
  activeLocale = 'ko';
  const f = await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const url = '/business/operations?company=company-header&stage=formation&task=task-header';
  await page.goto(url);
  await expect(page.getByRole('region', { name: ui('최신 결과'), exact: true })).toContainText('Initial formation plan');
  await expect(page.getByRole('region', { name: ui('진행 과정과 변경 내역'), exact: true })).toContainText('Agent research and supporting evidence');
  const record = page.getByRole('region', { name: ui('에이전트에게 요청'), exact: true });
  await record.locator('summary').click();
  await record.getByLabel(ui('실행 없이 기록만 남기기'), { exact: true }).check();
  await record.getByLabel(ui('업무 기록 내용')).fill('기존 설립 계획에서 비용 비교와 다음 단계를 보완해 주세요.');
  await record.getByRole('button', { name: ui('기록 남기기'), exact: true }).click();
  const requests = page.getByRole('region', { name: ui('남은 추가·수정 요청'), exact: true });
  await expect(requests).toContainText('비용 비교와 다음 단계');
  await page.reload();
  await expect(requests).toContainText('비용 비교와 다음 단계');
  await page.getByRole('region', { name: ui('최신 결과'), exact: true }).locator('summary').last().click();
  await page.getByRole('button', { name: ui('수정 결과 남기기'), exact: true }).click();
  await record.getByLabel(ui('업무 기록 내용')).fill('수정 결과: 두 옵션의 비용을 비교했습니다. 다음 단계는 서류 검토입니다.');
  await record.getByRole('button', { name: ui('기록 남기기'), exact: true }).click();
  await expect(page.getByRole('region', { name: ui('최신 결과'), exact: true })).toContainText('수정 결과: 두 옵션');
  await requests.getByText(ui('직접 처리한 경우'), { exact: true }).click();
  await requests.getByRole('button', { name: ui('처리 결과 남기기'), exact: true }).click();
  await record.getByLabel(ui('업무 기록 내용')).fill('수정 결과에 비용 비교와 다음 단계를 반영했습니다.');
  await record.getByRole('button', { name: ui('기록 남기기'), exact: true }).click();
  await expect(requests).toContainText(ui('처리를 기다리는 업무 요청이 없습니다.'));
  const history = page.getByRole('region', { name: ui('진행 과정과 변경 내역'), exact: true });
  await expect(history).toContainText('Initial formation plan');
  await expect(history).toContainText('수정 결과에 비용 비교와 다음 단계를 반영했습니다.');
  await expect(history).toContainText(ui('처리 기록 있음'));
  await page.getByRole('button', { name: ui('업무 목록으로'), exact: false }).first().click();
  await expect(page).not.toHaveURL(/task=/);
  await page.goBack();
  await expect(page).toHaveURL(/task=task-header/);
  await expect(page.getByRole('region', { name: ui('최신 결과'), exact: true })).toContainText('수정 결과: 두 옵션');
  expect(f.journal.entries.filter(entry => entry.kind === 'result')).toHaveLength(2);
  expect(f.requests.filter(path => path.endsWith('/ticket'))).toHaveLength(0);
  expect(f.errors).toEqual([]);
});

test('left Business menu exposes Mail and opens the same inbox as the top navigation', async ({ page }) => {
  const f = await fixture(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/business?company=company-header');
  const sidebar = page.locator('section[aria-labelledby="sidebar-business"]');
  const mail = sidebar.getByRole('button', { name: ui('메일'), exact: true });
  await expect(mail).toBeVisible();
  await mail.click();
  await expect(page).toHaveURL(/\/business\/mail$/);
  await expect(page.getByRole('region', { name: ui('통합 메일 목록') })).toBeVisible();
  await expect(page.locator('.business-nav a[href="/business/mail"]')).toHaveClass(/active/);
  expect(f.errors).toEqual([]);
});


for (const size of [{ width: 320, height: 568 }, { width: 768, height: 1024 }, { width: 667, height: 375 }]) {
  test(`company formation starts from overview and continues in one work item at ${size.width}x${size.height}`, async ({ page }) => {
    activeLocale = 'ko'; await page.setViewportSize(size);
    const f = await fixture(page);
    await page.goto('/business?company=company-header');
    await page.getByRole('button', { name: ui('회사 설립 맡기기'), exact: true }).click();
    const dialog = page.getByRole('dialog', { name: ui('에이전트에게 업무 맡기기') });
    await expect(dialog.getByLabel(ui('맡길 목표 · 요청'))).toHaveValue(/회사 설립/);
    await dialog.getByRole('button', { name: ui('이 설정으로 실행'), exact: true }).click();
    await expect(page).toHaveURL(/task=task-header/);
    await expect(page.getByRole('region', { name: ui('에이전트 실행'), exact: true })).toContainText(ui('실행 대기'));
    expect(f.requests.some(path => path.endsWith('/formation-work'))).toBe(true);
    const run = f.journal.runs[0];
    run.status = 'needs_input'; run.question = '사업 목적을 확인해 주세요. 신청 초안은 준비했습니다.';
    const result = { id: 'agent-result', kind: 'result', content: '설립 방식과 비용 비교, 신청 초안을 준비했습니다.', author: 'Business Host/Formation assistant', author_type: 'agent', revision: ++f.journal.company_revision, created_at: new Date().toISOString(), changes: null, resolves_entry_id: null };
    f.journal.entries.unshift(result); f.journal.result = result;
    await page.reload();
    await expect(page.getByRole('region', { name: ui('최신 결과'), exact: true })).toContainText(result.content);
    await page.getByRole('button', { name: ui('답변하고 이어서 진행'), exact: true }).click();
    const content = page.getByLabel(ui('업무 기록 내용'));
    await expect(content).toBeFocused(); await expect(content).toBeInViewport();
    await content.fill('사업 목적은 소프트웨어 개발입니다. 이 내용으로 신청 초안을 수정해 주세요.');
    await page.getByRole('button', { name: ui('에이전트에게 보내기'), exact: true }).click();
    await expect(page.getByRole('region', { name: ui('에이전트 실행'), exact: true })).toContainText(ui('실행 대기'));
    await expect(content).toHaveValue('');
    expect(f.journal.runs).toHaveLength(2);
    await page.reload();
    await expect(page.getByRole('region', { name: ui('진행 과정과 변경 내역'), exact: true })).toContainText('소프트웨어 개발');
    await expect(page.getByRole('region', { name: ui('최신 결과'), exact: true })).toContainText(result.content);
    expect(f.requests.some(path => path.endsWith('/ticket'))).toBe(false);
    expect(f.errors).toEqual([]);
  });
}


test('first-time Business agent setup is available in the work dialog on a narrow phone', async ({ page }, testInfo) => {
  activeLocale = 'ko'; await page.setViewportSize({ width: 320, height: 568 });
  const f = await fixture(page);
  await page.route('**/api/business/companies/company-header', route => route.fulfill({ json: { company, tasks: [], formations: [], connections: [], events: [], campaigns: [] } }));
  await page.route('**/api/agent-templates', route => route.fulfill({ json: [{ id: 'business-template', name: 'Business assistant', host_id: runtime.manager_agent_id, cli: runtime.cli, model: null, effort: null, runtime_config: runtime.runtime_config }] }));
  await page.goto('/business?company=company-header');
  await page.getByRole('button', { name: ui('회사 설립 맡기기'), exact: true }).click();
  const dialog = page.getByRole('dialog', { name: ui('에이전트에게 업무 맡기기') });
  const run = dialog.getByRole('button', { name: ui('이 설정으로 실행'), exact: true });
  await expect(run).toBeInViewport(); await expect(run).toBeDisabled();
  await dialog.getByLabel(ui('Agent 템플릿 (선택 사항)'), { exact: true }).selectOption('business-template');
  await dialog.getByLabel(ui('Working dir (Host 절대 경로)'), { exact: true }).fill('/work/company');
  await expect(run).toBeEnabled(); await expect(run).toBeInViewport();
  await page.screenshot({ path: testInfo.outputPath('business-first-agent-setup.png') });
  await run.click(); await expect(page).toHaveURL(/task=task-header/);
  expect(f.journal.runs).toHaveLength(1);
  expect(f.errors).toEqual([]);
});
