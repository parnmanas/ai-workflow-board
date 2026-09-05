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
const runtimeHost = {
  instance_id: 'runtime-instance-codex',
  agent_id: 'runtime-host-codex',
  agent_name: 'Codex Runtime Host',
  workspace_id: workspace.id,
  mode: 'manager',
  hostname: 'codex-host.test',
  plugin_version: '1.0.0',
  cli: 'codex',
  cli_adapters: ['codex'],
  pid: 1234,
  started_at: '2026-09-02T00:00:00.000Z',
  last_seen_at: '2026-09-02T00:00:00.000Z',
  agent_ids: [],
  working_dirs: [],
  runtime_capabilities: {
    codex: { installed: true, healthy: true },
  },
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
    } else if (path === '/claude-backend-profiles') {
      // 티켓 e616dbfc — 워크스페이스 스코프 라우트 2개가 이 전역 카탈로그
      // 하나로 대체됐다(비관리자 읽기 표면).
      body = { profiles: [profile], default_profile_id: profile.id };
    } else if (path === '/agents/dashboard') {
      body = [];
    } else if (path === '/admin/agent-manager/managers') {
      body = [{ id: runtimeHost.agent_id, name: runtimeHost.agent_name, workspace_id: workspace.id, is_active: 1 }];
    } else if (path === '/admin/agent-manager/instances') {
      body = [runtimeHost];
    } else if (path === `/workspaces/${workspace.id}/credentials`) {
      body = [];
    } else if (path === `/workspaces/${workspace.id}/mentions/unread`) {
      body = { items: [], total: 0 };
    } else if (path.includes('unread') || path.includes('counts')) {
      body = { count: 0, total: 0, per_room: {}, per_ticket: {}, per_board: {} };
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

async function openCliReference(page) {
  await page.goto(`/ws/${workspace.id}/agents`);
  await page.getByRole('button', { name: '+ New Agent', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New Managed Agent' });
  await expect(dialog).toBeVisible();
  const selects = dialog.locator('select');
  await expect(selects.nth(0).locator(`option[value="${runtimeHost.agent_id}"]`)).toHaveCount(1);
  await selects.nth(0).selectOption(runtimeHost.agent_id);
  await selects.nth(1).selectOption('codex');
  await expect(selects.nth(2)).toBeEnabled();
  return dialog;
}

async function commonPattern(surfaceLocator) {
  return surfaceLocator.evaluate(surface => {
    const input = surface?.querySelector('input');
    const select = surface?.querySelector('select');
    const buttons = surface?.querySelectorAll('button');
    const button = buttons?.item(buttons.length - 1);
    if (!surface || !input || !select || !button) throw new Error('비교할 공통 UI 표식이 없습니다.');
    const style = element => {
      const computed = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        width: rect.width,
        height: rect.height,
        borderRadius: computed.borderRadius,
        fontFamily: computed.fontFamily,
        fontSize: computed.fontSize,
        backgroundColor: computed.backgroundColor,
        borderStyle: computed.borderStyle,
      };
    };
    return {
      surface: style(surface),
      input: style(input),
      select: style(select),
      button: style(button),
      documentScrollWidth: document.documentElement.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
    };
  });
}

function expectSharedControls(claude, cli) {
  expect(claude.input.height).toBe(cli.input.height);
  expect(claude.input.borderRadius).toBe(cli.input.borderRadius);
  expect(claude.input.fontFamily).toBe(cli.input.fontFamily);
  expect(claude.input.fontSize).toBe(cli.input.fontSize);
  expect(claude.select.height).toBe(cli.select.height);
  expect(claude.select.borderRadius).toBe(cli.select.borderRadius);
  expect(claude.button.borderRadius).toBe(cli.button.borderRadius);
  expect(claude.button.fontFamily).toBe(cli.button.fontFamily);
  expect(claude.button.fontSize).toBe(cli.button.fontSize);
  expect(claude.surface.backgroundColor).toBe(cli.surface.backgroundColor);
  expect(claude.surface.borderStyle).toBe('solid');
  expect(cli.surface.borderStyle).toBe('solid');
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

test('데스크톱에서 Claude와 Codex CLI 기준 화면을 같은 viewport로 비교한다', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openProfiles(page);
  const measured = await layout(page);

  expect(measured.editor.x).toBeGreaterThan(measured.list.x + measured.list.width);
  expect(Math.abs(measured.editor.y - measured.list.y)).toBeLessThanOrEqual(1);
  expect(measured.shellScrollWidth).toBe(measured.shellClientWidth);
  expect(measured.documentScrollWidth).toBe(measured.documentClientWidth);
  await page.screenshot({ path: testInfo.outputPath('claude-profile-desktop.png'), fullPage: true });

  const claudePattern = await commonPattern(page.locator('[data-layout="responsive-profile-columns"] > :last-child'));
  const cliDialog = await openCliReference(page);
  const cliPattern = await commonPattern(cliDialog);
  expectSharedControls(claudePattern, cliPattern);
  expect(cliPattern.surface.width).toBeLessThanOrEqual(600);
  expect(cliPattern.documentScrollWidth).toBe(cliPattern.documentClientWidth);
  await cliDialog.screenshot({ path: testInfo.outputPath('codex-cli-profile-desktop.png') });
});

test('좁은 화면에서 Claude와 Codex CLI 기준 화면 모두 overflow 없이 공통 컨트롤을 유지한다', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openProfiles(page);
  const measured = await layout(page);

  expect(measured.editor.y).toBeGreaterThan(measured.list.y + measured.list.height);
  expect(Math.abs(measured.editor.x - measured.list.x)).toBeLessThanOrEqual(1);
  expect(measured.shellScrollWidth).toBe(measured.shellClientWidth);
  expect(measured.documentScrollWidth).toBe(measured.documentClientWidth);
  expect(measured.shell.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('claude-profile-narrow.png'), fullPage: true });

  const claudePattern = await commonPattern(page.locator('[data-layout="responsive-profile-columns"] > :last-child'));
  const cliDialog = await openCliReference(page);
  const cliPattern = await commonPattern(cliDialog);
  expectSharedControls(claudePattern, cliPattern);
  expect(cliPattern.surface.width).toBeLessThanOrEqual(390 - 32);
  expect(cliPattern.documentScrollWidth).toBe(cliPattern.documentClientWidth);
  await cliDialog.screenshot({ path: testInfo.outputPath('codex-cli-profile-narrow.png') });
});
