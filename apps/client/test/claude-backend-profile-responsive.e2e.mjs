import { test, expect } from '@playwright/test';

const workspace = { id: 'ws-claude-profile', name: '프로필 비교', slug: 'profile-compare', relations: ['admin'] };
const profile = {
  id: 'profile-responsive',
  name: 'Claude 호환 프로필',
  kind: 'claude-backend',
  protocol: 'openai-compatible',
  base_url: 'https://claude.example.test/v1',
  model: 'claude-compatible',
  omit_effort: true,
  credential_required: true,
  auth_env: 'ANTHROPIC_AUTH_TOKEN',
  adapter: { request: { model_field: 'model' } },
};

async function stubApi(page) {
  await page.addInitScript(({ workspaceId }) => {
    localStorage.setItem('auth_token', 'e2e-token');
    localStorage.setItem('currentWorkspaceId', workspaceId);
    localStorage.setItem('awb.viewMode', 'advanced');
  }, { workspaceId: workspace.id });

  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '');
    let body = [];
    if (path === '/auth/me') {
      body = {
        id: 'user-e2e', name: 'E2E 관리자', email: 'e2e@example.test', role: 'admin',
        status: 'active', permissions: '["admin.access"]', resolved_permissions: ['admin.access'], workspaces: [workspace],
      };
    } else if (path === '/workspaces') {
      body = [workspace];
    } else if (path === `/workspaces/${workspace.id}`) {
      body = workspace;
    } else if (path === '/admin/claude-backend-profiles') {
      body = { profiles: [profile], default_profile_id: profile.id };
    } else if (path === '/credentials') {
      body = [];
    } else if (path === `/workspaces/${workspace.id}/claude-backend-profiles/catalog`) {
      body = { profiles: [profile] };
    } else if (path === `/workspaces/${workspace.id}/claude-backend-profiles`) {
      body = { profiles: [profile], allowed_profile_ids: [profile.id], default_profile_id: profile.id };
    } else if (path === `/workspaces/${workspace.id}/mentions/unread`) {
      body = { items: [], total: 0 };
    } else if (path.includes('unread') || path.includes('counts')) {
      body = { count: 0, total: 0, per_room: {}, per_ticket: {}, per_board: {} };
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

async function openProfiles(page) {
  await stubApi(page);
  await page.goto(`/ws/${workspace.id}/settings/claude-profiles`);
  await expect(page.getByTestId('claude-profile-manager')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Claude Backend Profiles', exact: true })).toBeVisible();
}

async function layout(page) {
  return page.evaluate(() => {
    const shell = document.querySelector('[data-layout="responsive-profile-columns"]');
    const list = shell?.firstElementChild;
    const editor = shell?.lastElementChild;
    if (!shell || !list || !editor) throw new Error('Claude 프로필 레이아웃 표식이 없습니다.');
    const rect = element => {
      const value = element.getBoundingClientRect();
      return { x: value.x, y: value.y, width: value.width, height: value.height };
    };
    return {
      shell: rect(shell), list: rect(list), editor: rect(editor),
      shellScrollWidth: shell.scrollWidth,
      shellClientWidth: shell.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
    };
  });
}

test('데스크톱에서 기존 프로필 화면과 같은 카드형 2열 정보 구조를 유지한다', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openProfiles(page);
  const measured = await layout(page);

  expect(measured.editor.x).toBeGreaterThan(measured.list.x + measured.list.width);
  expect(Math.abs(measured.editor.y - measured.list.y)).toBeLessThanOrEqual(1);
  expect(measured.shellScrollWidth).toBe(measured.shellClientWidth);
  expect(measured.documentScrollWidth).toBe(measured.documentClientWidth);
  await page.screenshot({ path: testInfo.outputPath('claude-profile-desktop.png'), fullPage: true });
});

test('좁은 화면에서 단일 열로 전환하고 가로 overflow를 만들지 않는다', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openProfiles(page);
  const measured = await layout(page);

  expect(measured.editor.y).toBeGreaterThan(measured.list.y + measured.list.height);
  expect(Math.abs(measured.editor.x - measured.list.x)).toBeLessThanOrEqual(1);
  expect(measured.shellScrollWidth).toBe(measured.shellClientWidth);
  expect(measured.documentScrollWidth).toBe(measured.documentClientWidth);
  expect(measured.shell.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('claude-profile-narrow.png'), fullPage: true });
});
