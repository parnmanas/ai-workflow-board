import { test, expect } from '@playwright/test';

const workspace = { id: 'ws-scroll', name: 'Scroll Test', slug: 'scroll-test', relations: ['admin'] };

function agentFixture(kind) {
  return {
    id: `agent-${kind}`,
    name: `${kind} content agent`,
    description: kind === 'long'
      ? Array.from({ length: 80 }, (_, i) => `Deterministic content line ${i + 1}`).join('\n')
      : '',
    avatar_url: '',
    status: 'idle',
    source: 'manual',
    redacted: true,
    active_tasks: [],
    completed_tasks: 0,
    failed_tasks: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

async function stubApi(page, kind) {
  await page.addInitScript(({ workspaceId }) => {
    localStorage.setItem('auth_token', 'e2e-token');
    localStorage.setItem('currentWorkspaceId', workspaceId);
    localStorage.setItem('awb.viewMode', 'advanced');
  }, { workspaceId: workspace.id });

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api/, '');
    let body = [];
    if (path === '/auth/me') {
      body = {
        id: 'user-e2e',
        name: 'E2E User',
        email: 'e2e@example.test',
        role: 'member',
        status: 'active',
        permissions: [],
        workspaces: [workspace],
      };
    } else if (path === '/workspaces') {
      body = [workspace];
    } else if (path === `/agents/agent-${kind}`) {
      body = agentFixture(kind);
    } else if (path === `/agents/agent-${kind}/activity`) {
      body = [];
    } else if (path === '/agents/active-sessions') {
      body = {};
    } else if (path.includes('unread') || path.includes('counts')) {
      body = { count: 0, total: 0, per_room: {}, per_ticket: {}, per_board: {} };
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
}

async function openFixture(page, kind) {
  await stubApi(page, kind);
  await page.goto(`/ws/${workspace.id}/agents/agent-${kind}`);
  await expect(page.getByRole('region', { name: `${kind} content agent` })).toBeVisible();
}

async function geometry(page) {
  return page.evaluate(() => {
    const scroll = document.querySelector('[data-testid="agent-content-scroll"]');
    const end = document.querySelector('[data-testid="agent-content-end"]');
    const header = document.querySelector('[data-testid="app-header"]');
    const sidebar = document.querySelector('[data-testid="app-sidebar"]');
    if (!scroll || !end || !header || !sidebar) throw new Error('production layout markers missing');
    const rect = (element) => {
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    return {
      clientHeight: scroll.clientHeight,
      scrollHeight: scroll.scrollHeight,
      scrollTop: scroll.scrollTop,
      end: rect(end),
      header: rect(header),
      sidebar: rect(sidebar),
      documentClientHeight: document.documentElement.clientHeight,
      documentScrollHeight: document.documentElement.scrollHeight,
    };
  });
}

for (const viewport of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'narrow', width: 767, height: 900 },
]) {
  test.describe(viewport.name, () => {
    test.use({ viewport });

    test('long Agent Content scrolls by wheel and keyboard without moving the shell', async ({ page }) => {
      await openFixture(page, 'long');
      const scroll = page.getByTestId('agent-content-scroll');
      const before = await geometry(page);

      expect(before.scrollHeight).toBeGreaterThan(before.clientHeight);
      expect(before.documentScrollHeight).toBe(before.documentClientHeight);

      await scroll.hover();
      await page.mouse.wheel(0, 480);
      await expect.poll(async () => (await geometry(page)).scrollTop).toBeGreaterThan(0);
      const afterWheel = await geometry(page);
      expect(afterWheel.header).toEqual(before.header);
      expect(afterWheel.sidebar).toEqual(before.sidebar);

      await scroll.focus();
      await page.keyboard.press('Home');
      await expect.poll(async () => (await geometry(page)).scrollTop).toBe(0);
      await page.keyboard.press('End');
      await expect.poll(async () => {
        const g = await geometry(page);
        return Math.round(g.scrollTop + g.clientHeight);
      }).toBe(before.scrollHeight);

      const atEnd = await geometry(page);
      expect(atEnd.end.y + atEnd.end.height).toBeLessThanOrEqual(viewport.height);
      expect(atEnd.end.y).toBeGreaterThanOrEqual(atEnd.header.y + atEnd.header.height);
      expect(atEnd.header).toEqual(before.header);
      expect(atEnd.sidebar).toEqual(before.sidebar);
      expect(atEnd.documentScrollHeight).toBe(atEnd.documentClientHeight);
    });

    test('short Agent Content does not create an unnecessary scrollbar', async ({ page }) => {
      await openFixture(page, 'short');
      const measured = await geometry(page);
      expect(measured.scrollHeight).toBe(measured.clientHeight);
      expect(measured.documentScrollHeight).toBe(measured.documentClientHeight);
    });
  });
}
