import { test, expect } from '@playwright/test';
import { cliCatalog } from '../src/cli/catalog.ts';

const message = (index) => `History message ${String(index).padStart(3, '0')}`;
const event = (index) => ({ id: `event-${index}`, seq: index + 1, type: 'text', turn_id: `turn-${index}`,
  payload: { text: message(index) }, created_at: '2026-11-18T10:00:00.000Z' });
const events = (from, to) => Array.from({ length: to - from }, (_, i) => event(from + i));

async function fixture(page) {
  const reads = [];
  const pending = [];
  const account = { id: 'history-account', name: 'Personal', owner_user_id: 'history-user' };
  const host = { manager_id: 'history-host', instance_id: 'instance', hostname: 'host', name: 'Host',
    clis: ['codex'], last_seen_at: new Date().toISOString() };
  const live = { manager_id: host.manager_id, manager_name: 'Host', cli: 'codex', session_id: 'history-session',
    title: 'Paged conversation', cwd: '/repo', status: 'ready', available_modes: [], current_mode: null,
    config_options: [], available_commands: [], pending_permissions: [], pending_elicitations: [],
    updated_at: new Date().toISOString() };
  await page.addInitScript((accountId) => {
    localStorage.setItem('locale', 'en');
    localStorage.setItem('auth_token', 'history-test');
    localStorage.setItem('currentAccountId', accountId);
    window.EventSource = class extends EventTarget {
      readyState = 1;
      constructor() { super(); window.historyTestStream = this; }
      close() { this.readyState = 2; }
    };
  }, account.id);
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api/, '');
    let body = [];
    if (path === '/auth/me') body = { id: 'history-user', name: 'User', role: 'admin', status: 'active',
      resolved_permissions: ['agent_sessions.use'], accounts: [account] };
    else if (path === '/auth/setup-status') body = { needs_setup: false };
    else if (path === '/cli-catalog') body = { clis: cliCatalog() };
    else if (path === '/accounts') body = [account];
    else if (path === '/agent-sessions/hosts') body = [host];
    else if (path.endsWith('/history-session/usage-limits')) body = { events: [] };
    else if (path.endsWith('/sessions/history-session')) {
      const before = url.searchParams.get('before');
      reads.push(before);
      if (before) {
        return new Promise(resolve => pending.push({ before, route, resolve }));
      }
      body = { session: live, live, events: events(40, 80), next_before: 'event-40' };
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
    reads,
    async respond(before, from, to, next, error = null) {
      await expect.poll(() => pending.some(item => item.before === before)).toBe(true);
      const index = pending.findIndex(item => item.before === before);
      const item = pending.splice(index, 1)[0];
      await item.route.fulfill({ status: error ? 503 : 200, contentType: 'application/json',
        body: JSON.stringify(error ? { error } : { session: live, live, events: events(from, to), next_before: next }) });
      item.resolve();
    },
    async emit(index) {
      await page.evaluate(data => window.historyTestStream.dispatchEvent(new MessageEvent('agent_session_event', {
        data: JSON.stringify(data),
      })), { manager_id: host.manager_id, cli: 'codex', session_id: live.session_id, event: event(index) });
    },
  };
}

for (const size of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`scrolling up pages through history without moving the reader at ${size.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(size);
    const f = await fixture(page);
    const transcript = page.locator('.awb-session-transcript');
    const text = index => transcript.getByText(message(index), { exact: true });
    await expect(text(79)).toBeInViewport();
    expect(f.reads).toEqual([null]);

    await transcript.hover();
    await page.mouse.wheel(0, -20_000);
    await expect.poll(() => f.reads).toEqual([null, 'event-40']);
    await expect(transcript.getByRole('button', { name: 'Loading…', exact: true })).toBeDisabled();
    // Repeated scroll events must not enqueue another request for the same cursor.
    await transcript.evaluate(node => { for (let i = 0; i < 4; i++) node.dispatchEvent(new Event('scroll')); });
    expect(f.reads).toHaveLength(2);
    const beforeLive = (await text(40).boundingBox()).y;
    await f.emit(80);
    await expect(text(80)).toHaveCount(1);
    expect(Math.abs((await text(40).boundingBox()).y - beforeLive)).toBeLessThanOrEqual(2);

    // Move while the host is still reading. Anchor at the position when the response arrives.
    await page.mouse.wheel(0, 50);
    await expect.poll(() => transcript.evaluate(node => node.scrollTop)).toBeGreaterThan(20);
    const beforePrepend = (await text(40).boundingBox()).y;
    await f.respond('event-40', 20, 41, 'event-20'); // overlap exercises stable-id deduplication
    await expect(text(20)).toHaveCount(1);
    await expect(text(40)).toHaveCount(1);
    expect(Math.abs((await text(40).boundingBox()).y - beforePrepend)).toBeLessThanOrEqual(2);

    await page.mouse.wheel(0, -20_000);
    await expect.poll(() => f.reads).toEqual([null, 'event-40', 'event-20']);
    await f.respond('event-20', 0, 20, null, 'History page unavailable');
    await expect(transcript.getByRole('alert')).toHaveText('History page unavailable');
    const retry = transcript.getByRole('button', { name: 'Load older records', exact: true });
    await expect(retry).toBeEnabled();
    await expect(text(20)).toHaveCount(1);
    await retry.click();
    await f.respond('event-20', 0, 20, null);
    await expect(text(0)).toHaveCount(1);
    await expect(transcript.getByRole('alert')).toHaveCount(0);
    await expect(retry).toHaveCount(0);
    const rendered = await transcript.locator('[data-block="assistant"]').allTextContents();
    expect(rendered.map(value => value.trim())).toEqual(Array.from({ length: 81 }, (_, i) => message(i)));
    const requestCount = f.reads.length;
    await page.mouse.wheel(0, -20_000);
    await expect.poll(() => transcript.evaluate(node => node.scrollTop)).toBe(0);
    await transcript.evaluate(node => node.dispatchEvent(new Event('scroll')));
    expect(f.reads).toHaveLength(requestCount);
    await page.screenshot({ path: testInfo.outputPath('loaded-earlier-history.png') });
  });
}
