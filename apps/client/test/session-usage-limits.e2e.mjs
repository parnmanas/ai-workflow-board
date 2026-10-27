import { test, expect } from '@playwright/test';
import { cliCatalog } from '../src/cli/catalog.ts';

async function fixture(page, { missing = false, expired = false } = {}) {
  const account = { id: 'quota-account', name: 'Personal', owner_user_id: 'quota-user' };
  const host = { manager_id: 'quota-host', instance_id: 'instance', hostname: 'host', name: 'Host', clis: ['codex'], plugin_version: '1.0.0', last_seen_at: new Date().toISOString() };
  const live = { manager_id: host.manager_id, manager_name: 'Host', cli: 'codex', session_id: 'quota-session', title: 'Usage limit gauge', cwd: '/repo', status: 'ready', available_modes: [], current_mode: null, config_options: [], available_commands: [], updated_at: new Date().toISOString() };
  const events = missing ? [] : [{ id: 'quota-snapshot', seq: 1, turn_id: '', type: 'usage_limits', created_at: live.updated_at, payload: {
    limit_id: 'codex', observed_at: live.updated_at,
    windows: [
      { id: 'primary', used_percent: 42, window_minutes: 300, resets_at: new Date(Date.now() + (expired ? -1 : 1) * 3600000).toISOString() },
      { id: 'secondary', used_percent: 91, window_minutes: 10080, resets_at: new Date(Date.now() + 86400000).toISOString() },
    ],
  } }];
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
    else if (path.endsWith('/quota-session')) body = { session: live, live, events };
    else if (path.endsWith('/sessions')) body = [live];
    else if (path === '/voice/config') body = { stt: { ready: false }, tts: { ready: false }, wake: { ready: false } };
    else if (path === '/voice/operators') body = { operators: [] };
    else if (path.endsWith('/models')) body = { models: [] };
    else if (path.includes('/unread') || path.includes('/counts')) body = { count: 0, total: 0, items: [], perRoom: {}, perTicket: {} };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto(`/sessions/${host.manager_id}/codex/${live.session_id}`);
}

for (const size of [{ width: 320, height: 568 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }, { width: 667, height: 375 }]) {
  test(`quota gauges and composer remain visible at ${size.width}x${size.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(size);
    await fixture(page);
    const primary = page.getByRole('meter', { name: '5h limit', exact: true });
    await expect(primary).toHaveAttribute('aria-valuenow', '42');
    await expect(page.getByRole('meter', { name: '7d limit', exact: true })).toHaveAttribute('aria-valuenow', '91');
    await expect(page.getByText('42% used', { exact: true })).toBeVisible();
    await expect(page.locator('[data-session-usage-limits]')).toContainText('Resets');
    await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toBeInViewport();
    await expect(primary).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('usage-limits.png') });
  });
}

test('missing quota is unknown, and an expired snapshot waits for another report', async ({ page }) => {
  await fixture(page, { missing: true });
  await expect(page.getByText('No usage limits reported by this CLI', { exact: true })).toBeVisible();
  await expect(page.getByRole('meter')).toHaveCount(0);
  await page.unroute('**/api/**');
  await fixture(page, { expired: true });
  await expect(page.getByText('Awaiting update', { exact: true })).toBeVisible();
  await expect(page.getByRole('meter')).toHaveCount(1);
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
  await expect(page.getByText('87% used', { exact: true })).toBeVisible();
  await expect(page.locator('.awb-session-transcript')).not.toContainText('87');
});
