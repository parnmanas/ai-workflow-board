import { test, expect } from '@playwright/test';
import { cliCatalog } from '../src/cli/catalog.ts';

async function fixture(page, { missing = false, expired = false } = {}) {
  const quotaReads = [];
  const historyReads = [];
  let quotaResponse;
  let failQuota = false;
  const account = { id: 'quota-account', name: 'Personal', owner_user_id: 'quota-user' };
  const host = { manager_id: 'quota-host', instance_id: 'instance', hostname: 'host', name: 'Host', clis: ['codex'], plugin_version: '1.0.0', last_seen_at: new Date().toISOString() };
  const live = { manager_id: host.manager_id, manager_name: 'Host', cli: 'codex', session_id: 'quota-session', title: 'Usage limit gauge with a long session title that must not push controls off screen', cwd: '/repo', status: 'ready', available_modes: [], current_mode: null, config_options: ['mode', 'model', 'thought_level'].map((category) => ({ config_id: category, category, name: category === 'thought_level' ? 'Effort' : category === 'model' ? 'Model' : 'Mode', type: 'select', current_value: 'default', options: [{ value: 'default', name: 'Default' }] })), available_commands: [], updated_at: new Date().toISOString() };
  const events = missing ? [] : [{ id: 'quota-snapshot', seq: 1, turn_id: '', type: 'usage_limits', created_at: live.updated_at, payload: {
    limit_id: 'codex', observed_at: live.updated_at,
    windows: [
      { id: 'primary', used_percent: 42, window_minutes: 300, resets_at: new Date(Date.now() + (expired ? -1 : 1) * 3600000).toISOString() },
      { id: 'secondary', used_percent: 91, window_minutes: 10080, resets_at: new Date(Date.now() + 86400000).toISOString() },
    ],
  } }];
  quotaResponse = { events };
  await page.addInitScript((accountId) => {
    localStorage.setItem('locale', 'en');
    localStorage.setItem('auth_token', 'quota-test');
    localStorage.setItem('currentAccountId', accountId);
    window.EventSource = class extends EventTarget {
      readyState = 1;
      constructor() { super(); window.quotaStream = this; }
      close() { this.readyState = 2; }
    };
  }, account.id);
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '');
    let body = [];
    if (path === '/auth/me') body = { id: 'quota-user', name: 'User', role: 'admin', status: 'active', resolved_permissions: ['admin.access', 'agent_sessions.use', 'voice.use'], accounts: [account] };
    else if (path === '/auth/setup-status') body = { needs_setup: false };
    else if (path === '/cli-catalog') body = { clis: cliCatalog() };
    else if (path === '/accounts') body = [account];
    else if (path === '/agent-sessions/hosts') body = [host];
    else if (path.endsWith('/quota-session/usage-limits')) {
      quotaReads.push(path);
      if (failQuota) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'offline' }) });
      body = quotaResponse;
    }
    else if (path.endsWith('/quota-session')) {
      historyReads.push(path);
      body = { session: live, live, events: [
        { id: 'original-prompt', seq: 1, turn_id: 'original', type: 'user_prompt', payload: { text: 'Original request' }, created_at: live.updated_at },
        { id: 'original-answer', seq: 2, turn_id: 'original', type: 'text', payload: { text: 'Existing answer' }, created_at: live.updated_at },
        ...events,
      ] };
    }
    else if (path.endsWith('/sessions')) body = [live];
    else if (path === '/voice/config') body = { stt: { ready: false }, tts: { ready: false }, wake: { ready: false } };
    else if (path === '/voice/operators') body = { operators: [] };
    else if (path.endsWith('/models')) body = { models: [] };
    else if (path.includes('/unread') || path.includes('/counts')) body = { count: 0, total: 0, items: [], perRoom: {}, perTicket: {} };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto(`/sessions/${host.manager_id}/codex/${live.session_id}`);
  return {
    quotaReads, historyReads,
    setQuota: (value) => { quotaResponse = value; },
    failQuota: (value) => { failQuota = value; },
  };
}

for (const size of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }, { width: 667, height: 375 }]) {
  test(`quota forms the header divider and details open from the menu at ${size.width}x${size.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(size);
    await fixture(page);
    const boundary = page.locator('[data-session-usage-limits="boundary"]');
    const primary = boundary.getByRole('meter', { name: '5h limit', exact: true });
    await expect(primary).toHaveAttribute('aria-valuenow', '42');
    await expect(boundary.getByRole('meter', { name: '7d limit', exact: true })).toHaveAttribute('aria-valuenow', '91');
    await expect(page.getByText('42% used', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Usage limits', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toBeInViewport();
    await expect(primary).toBeInViewport();
    expect(await boundary.textContent()).toBe('');
    expect((await boundary.boundingBox()).height).toBeLessThanOrEqual(5);
    await expect(page.locator('.awb-session-status [data-session-usage-limits]')).toHaveCount(0);
    const header = await page.locator('.awb-session-header').boundingBox();
    expect(header.height).toBeLessThanOrEqual(116);
    const divider = await boundary.boundingBox();
    expect(Math.abs(divider.x - header.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(divider.width - header.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(divider.y + divider.height - header.y - header.height)).toBeLessThanOrEqual(1);
    const transcript = await page.locator('.awb-session-transcript').boundingBox();
    expect(transcript.y).toBeLessThanOrEqual(header.y + header.height + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('usage-limits-boundary.png') });
    const trigger = page.getByRole('button', { name: 'Session menu', exact: true });
    await trigger.click();
    const details = page.locator('[data-session-usage-limits="details"]');
    await expect(details.getByText('42% used', { exact: true })).toBeVisible();
    await expect(details.getByText('91% used', { exact: true })).toBeVisible();
    await expect(details).toContainText('Resets');
    await expect(details).toContainText('Last reported');
    await expect(details).toBeInViewport();
    const panel = await page.locator('.awb-session-menu-panel').boundingBox();
    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(size.width);
    expect(panel.y + panel.height).toBeLessThanOrEqual(size.height);
    await page.screenshot({ path: testInfo.outputPath('usage-limits-menu.png') });
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });
}

test('missing quota keeps the normal divider; missing and expired details live in the menu', async ({ page }) => {
  await fixture(page, { missing: true });
  await expect(page.locator('[data-session-usage-limits="boundary"]')).toHaveCount(0);
  await expect(page.getByText('No usage limits reported by this CLI', { exact: true })).toHaveCount(0);
  const emptyHeaderHeight = (await page.locator('.awb-session-header').boundingBox()).height;
  await page.getByRole('button', { name: 'Session menu', exact: true }).click();
  await expect(page.getByText('No usage limits reported by this CLI', { exact: true })).toBeVisible();
  await expect(page.getByRole('meter')).toHaveCount(0);
  await page.unroute('**/api/**');
  await fixture(page, { expired: true });
  await expect(page.locator('[data-session-usage-limits="boundary"]')).toBeVisible();
  expect((await page.locator('.awb-session-header').boundingBox()).height).toBe(emptyHeaderHeight);
  await page.getByRole('button', { name: 'Session menu', exact: true }).click();
  await expect(page.getByText('Awaiting update', { exact: true })).toBeVisible();
  await expect(page.locator('[data-session-usage-limits="details"]').getByRole('meter')).toHaveCount(1);
});

test('new quota reports update the gauge without rendering a chat message', async ({ page }) => {
  await fixture(page);
  await expect(page.getByRole('meter', { name: '5h limit', exact: true })).toHaveAttribute('aria-valuenow', '42');
  await page.evaluate(() => {
    const observedAt = new Date(Date.now() + 1000).toISOString();
    window.quotaStream.dispatchEvent(new MessageEvent('agent_session_event', { data: JSON.stringify({
      manager_id: 'quota-host', cli: 'codex', session_id: 'quota-session',
      event: { id: 'new-quota', seq: 2, type: 'usage_limits', turn_id: '', created_at: observedAt, payload: {
        limit_id: 'codex', observed_at: observedAt, windows: [{ id: 'primary', used_percent: 87, window_minutes: 300, resets_at: new Date(Date.now() + 3600000).toISOString() }],
      } },
    }) }));
  });
  await expect(page.getByRole('meter', { name: '5h limit', exact: true })).toHaveAttribute('aria-valuenow', '87');
  await expect(page.getByText('87% used', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Session menu', exact: true }).click();
  await expect(page.getByText('87% used', { exact: true })).toBeVisible();
  await expect(page.locator('.awb-session-transcript')).not.toContainText('87');
});


const refreshedQuota = (used, session = 'quota-session', at = Date.now() + 1000) => ({ events: [{
  id: `${session}:quota:${at}`, seq: 1, turn_id: '', type: 'usage_limits', created_at: new Date(at).toISOString(),
  payload: { limit_id: 'codex', observed_at: new Date(at).toISOString(), windows: [{ id: 'primary', used_percent: used, window_minutes: 300, resets_at: new Date(Date.now() + 3600000).toISOString() }] },
}] });

async function foreground(page, visible = true) {
  await page.evaluate((visible) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: visible ? 'visible' : 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  }, visible);
}

test('foreground refreshes quota once without reloading conversation or losing the draft', async ({ page }) => {
  const f = await fixture(page);
  await expect.poll(() => f.quotaReads.length).toBe(1);
  const initialHistoryReads = f.historyReads.length;
  const draft = page.getByRole('textbox', { name: 'Prompt', exact: true });
  await draft.fill('Keep my draft');
  f.setQuota(refreshedQuota(68));
  await foreground(page, false);
  await page.waitForTimeout(200);
  expect(f.quotaReads.length).toBe(1);
  await foreground(page);
  await expect.poll(() => f.quotaReads.length).toBe(2);
  await expect(page.getByRole('meter', { name: '5h limit', exact: true })).toHaveAttribute('aria-valuenow', '68');
  await expect(draft).toHaveValue('Keep my draft');
  await expect(page.locator('.awb-session-transcript')).toContainText('Existing answer');
  expect(f.historyReads.length).toBe(initialHistoryReads);
  await page.waitForTimeout(200);
  expect(f.quotaReads.length).toBe(2);
});

test('failed focus refresh retains the last quota and retries on the next focus', async ({ page }) => {
  const f = await fixture(page);
  await expect.poll(() => f.quotaReads.length).toBe(1);
  const initialHistoryReads = f.historyReads.length;
  f.failQuota(true);
  await foreground(page);
  await expect.poll(() => f.quotaReads.length).toBe(2);
  await expect(page.getByRole('meter', { name: '5h limit', exact: true })).toHaveAttribute('aria-valuenow', '42');
  f.failQuota(false);
  f.setQuota(refreshedQuota(70));
  await foreground(page);
  await expect(page.getByRole('meter', { name: '5h limit', exact: true })).toHaveAttribute('aria-valuenow', '70');
  expect(f.historyReads.length).toBe(initialHistoryReads);
});

test('a quota response arriving after switching sessions cannot change the new session', async ({ page }) => {
  const f = await fixture(page);
  await expect.poll(() => f.quotaReads.length).toBe(1);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let held = 0;
  await page.route('**/quota-session/usage-limits', async route => {
    held += 1;
    await gate;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(refreshedQuota(99)) });
  });
  await page.route('**/other-session**', async route => {
    const body = route.request().url().endsWith('/usage-limits') ? refreshedQuota(10, 'other-session')
      : { session: { session_id: 'other-session', title: 'Other session', cli: 'codex' }, events: refreshedQuota(10, 'other-session').events, live: null };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await foreground(page);
  await expect.poll(() => held).toBe(1);
  await foreground(page);
  await page.waitForTimeout(200);
  expect(held).toBe(1);
  await page.evaluate(() => {
    history.pushState({}, '', '/sessions/quota-host/codex/other-session');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByRole('meter', { name: '5h limit', exact: true })).toHaveAttribute('aria-valuenow', '10');
  release();
  await page.waitForTimeout(200);
  await expect(page.getByRole('meter', { name: '5h limit', exact: true })).toHaveAttribute('aria-valuenow', '10');
});
