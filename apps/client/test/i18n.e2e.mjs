import { test, expect } from '@playwright/test';
import { cliCatalog } from '../src/cli/catalog.ts';

async function fixture(page, signedIn = false) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(authenticated => {
    if (authenticated) localStorage.setItem('auth_token', 'i18n-test');
    window.EventSource = class extends EventTarget { readyState = 1; close() {} };
  }, signedIn);
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '');
    let body = [];
    if (path === '/auth/setup-status') body = { needs_setup: false };
    else if (path === '/auth/oauth/providers') body = { google: false };
    else if (path === '/auth/me') body = { id: 'owner', name: '저장', status: 'active', role: 'user', resolved_permissions: ['agent_sessions.use', 'business.manage', 'marketing.manage'], accounts: [{ id: 'personal', name: 'Settings' }] };
    else if (path === '/cli-catalog') body = { clis: cliCatalog() };
    else if (path === '/voice/config') body = { stt: { ready: false }, tts: { ready: false }, wake: { ready: false } };
    else if (path === '/voice/operators') body = { operators: [] };
    else if (path === '/marketing/inbox') body = { summary: { total: 0 }, campaigns: [] };
    else if (path === '/projects') body = [{ id: 'p1', account_id: 'personal', name: '설정 / Settings / 日本語', description: '사용자가 작성한 내용', repo_url: 'https://example.com/repo.git', default_branch: 'main', host_folders: [] }];
    else if (path.includes('/unread') || path.endsWith('counts') || path.includes('/mentions')) body = { count: 0, total: 0, items: [], perRoom: {}, perTicket: {} };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return errors;
}

test('English default, four selectable languages, persisted preference and preserved login draft on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  const errors = await fixture(page);
  await page.goto('/');
  const selector = page.getByTestId('language-select');
  await expect(page.getByRole('heading', { name: 'Welcome Back' })).toBeVisible();
  await expect(selector).toHaveValue('en');
  await page.locator('input[type=email]').fill('draft@example.com');
  for (const [locale, heading, lang] of [['ko', '다시 오신 것을 환영합니다', 'ko'], ['ja', 'おかえりなさい', 'ja'], ['zh-CN', '欢迎回来', 'zh-Hans'], ['en', 'Welcome Back', 'en']]) {
    await selector.selectOption(locale);
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', lang);
    await expect(page.locator('input[type=email]')).toHaveValue('draft@example.com');
    await expect(selector).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await selector.selectOption('ja');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ja');
  await page.reload();
  await expect(selector).toHaveValue('ja');
  await expect(page.getByRole('heading', { name: 'おかえりなさい' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('authenticated navigation switches live while user names and project content retain their original language', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = await fixture(page, true);
  await page.goto('/projects');
  const sidebar = page.getByTestId('app-sidebar');
  await expect(page.getByText('설정 / Settings / 日本語', { exact: true })).toBeVisible();
  for (const [locale, tickets] of [['ko', '티켓'], ['ja', 'チケット'], ['zh-CN', '工单'], ['en', 'Tickets']]) {
    await sidebar.getByTestId('language-select').selectOption(locale);
    await expect(sidebar.getByText(tickets, { exact: true })).toBeVisible();
    await expect(sidebar.getByText('저장', { exact: true })).toBeVisible();
    await expect(page.getByText('설정 / Settings / 日本語', { exact: true })).toBeVisible();
  }
  expect(errors).toEqual([]);
});
