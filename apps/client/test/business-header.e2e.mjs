// Headers need height, hit-target and clipped-control checks, not just document scrollWidth.
import { test, expect } from '@playwright/test';
import { cliCatalog } from '../src/cli/catalog.ts';

const account = { id: 'business-header-account', name: 'Personal' };
const longName = '해외에서 운영하는 아주 긴 이름의 비즈니스 International Product and Customer Operations LLC';
const company = { id: 'company-header', name: longName, account_id: account.id, entity_type: 'LLC', country: 'US', jurisdiction: 'WY', description: '', campaign_ids: [], service_choices: {}, revision: 0 };
const campaign = { id: 'campaign-header', account_id: account.id, name: longName, status: 'active', capabilities: ['email'], currency: 'USD', cycle_interval_ms: 86400000, cycle_count: 12, limits: {}, payees: [], allowed_domains: [], agent_runtime: null, created_at: '2026-10-25T00:00:00Z', updated_at: '2026-10-25T00:00:00Z' };

async function fixture(page, permissions = ['business.manage', 'marketing.manage']) {
  const errors = []; const requests = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(accountId => {
    localStorage.setItem('auth_token', 'header-test'); localStorage.setItem('currentAccountId', accountId);
    window.EventSource = class extends EventTarget { readyState = 1; close() {} };
  }, account.id);
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
    else if (path === '/business/companies') body = [company, { ...company, id: 'company-other', name: 'Second LLC' }];
    else if (path.startsWith('/business/companies/') && !path.includes('/cashbook/')) body = { company, tasks: [], connections: [], campaigns: [], events: [], formations: [] };
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
  return { errors, requests };
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

for (const size of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1024, height: 768 }, { width: 1440, height: 900 }, { width: 667, height: 375 }]) {
  test(`Business headers keep navigation and actions usable at ${size.width}x${size.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(size);
    const f = await fixture(page);
    for (const [path, title] of [
      ['/business?company=company-header', '비즈니스 전체 흐름'],
      ['/business/operations?company=company-header&stage=growth', '운영 워크플로'],
      ['/business/connectors?company=company-header', '커넥터'],
      ['/business/mail', '비즈니스 메일'],
      ['/marketing', 'Marketing'],
      ['/marketing/contacts', 'Marketing Contacts'],
      ['/marketing/campaign-header?tab=audit', longName],
    ]) {
      await page.goto(path);
      await expect(page.locator('.business-page-heading h1')).toHaveText(title);
      if (path.includes('company=')) await expect(page.getByLabel('관리할 회사')).toHaveValue(company.id);
      await expectHeaderFits(page);
      const file = path.split('?')[0].replaceAll('/', '-');
      await page.screenshot({ path: testInfo.outputPath(`${file}.png`) });
      const menu = page.getByRole('button', { name: `${title} 메뉴`, exact: true });
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
      if (path.includes('/operations')) {
        const tabs = page.getByRole('group', { name: '운영 영역' });
        const active = tabs.locator('[aria-pressed=true]');
        const tabBounds = await tabs.boundingBox(); const activeBounds = await active.boundingBox();
        expect(tabBounds.height).toBeLessThanOrEqual(60);
        expect(activeBounds.x).toBeGreaterThanOrEqual(tabBounds.x);
        expect(activeBounds.x + activeBounds.width).toBeLessThanOrEqual(tabBounds.x + tabBounds.width + 1);
        await expect(page.locator('.business-operations-heading')).toBeInViewport();
      }
      if (path === '/business/mail') {
        await expect(page.getByRole('region', { name: '통합 메일 목록' })).toBeInViewport();
        await page.getByRole('button', { name: '필터', exact: true }).click();
        await page.getByLabel('모든 업무 용도', { exact: true }).selectOption('accounting');
        await page.getByRole('button', { name: '필터 (1)', exact: true }).click();
        await expect(page.getByLabel('모든 업무 용도', { exact: true })).toBeHidden();
        await expect(page).toHaveURL(/purpose=accounting/);
        await menu.click();
        await page.getByRole('button', { name: '연결 관리 (1)', exact: true }).click();
        await expect(page.getByRole('region', { name: '메일 연결', exact: true })).toBeVisible();
        await expect(menu).toHaveAttribute('aria-expanded', 'false');
      }
      if (path.includes('/campaign-header')) {
        await menu.click();
        await panel.getByRole('button', { name: '일시정지', exact: true }).click();
        await expect(page.getByRole('dialog', { name: '캠페인 일시정지', exact: true })).toBeVisible();
        await page.getByRole('button', { name: '취소', exact: true }).click();
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
  await expect(page.getByLabel('관리할 회사')).toHaveValue(company.id);
  for (const size of [{ width: 320, height: 568 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    await expectHeaderFits(page);
    const tabs = page.getByRole('group', { name: '운영 영역' });
    await expect.poll(() => tabs.evaluate(n => {
      const a = n.querySelector('[aria-pressed=true]').getBoundingClientRect(); const b = n.getBoundingClientRect();
      return a.left >= b.left && a.right <= b.right + 1;
    })).toBe(true);
  }
  await page.getByRole('navigation', { name: 'Business 메뉴' }).getByRole('link', { name: '커넥터', exact: true }).click();
  await expect(page).toHaveURL(/company=company-header/);
  await page.getByRole('button', { name: '커넥터 메뉴', exact: true }).click();
  const before = f.requests.filter(p => p === '/business/companies/company-header').length;
  await page.getByRole('button', { name: '워크플로 새로고침', exact: true }).click();
  await expect.poll(() => f.requests.filter(p => p === '/business/companies/company-header').length).toBeGreaterThan(before);
  await page.getByRole('button', { name: '회사 추가', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(f.errors).toEqual([]);
});

test('Marketing-only permissions keep Business navigation and menus scoped', async ({ page }) => {
  const f = await fixture(page, ['marketing.approve_spend']);
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/marketing/campaign-header?tab=audit');
  await expect(page.locator('.business-page-heading h1')).toHaveText(longName);
  await expect(page.getByRole('navigation', { name: 'Business 메뉴' }).getByRole('link')).toHaveCount(1);
  await page.getByRole('button', { name: `${longName} 메뉴`, exact: true }).click();
  await expect(page.locator('.business-heading-menu-actions').getByRole('link', { name: '← 목록' })).toBeVisible();
  await expect(page.locator('.business-page-heading').getByRole('button', { name: /지금 실행|설정|삭제/ })).toHaveCount(0);
  await page.goto('/marketing');
  await page.getByRole('button', { name: 'Marketing 메뉴', exact: true }).click();
  await expect(page.locator('.business-heading-menu-info')).toContainText('사람이 승인합니다');
  await expect(page.getByRole('button', { name: '+ 새 캠페인', exact: true })).toHaveCount(0);
  expect(f.requests.some(p => p.startsWith('/business/'))).toBe(false);
  expect(f.errors).toEqual([]);
});
