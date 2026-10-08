// Geometry and input behavior in real Chromium; server/host responses are fixtures.
import { test, expect } from '@playwright/test';
import { cliCatalog } from '../src/cli/catalog.ts';

const account = { id: 'responsive-account', name: 'Test account', relations: ['admin'] };
const host = { manager_id: 'responsive-host', instance_id: 'instance', name: 'Ralf', hostname: 'ralf.test', clis: ['codex'], cli_settings: {}, plugin_version: '1.0.0', last_seen_at: new Date().toISOString() };
const sessionPath = `/sessions/${host.manager_id}/codex/session-responsive`;
const title = '모바일에서도 긴 제목과 경로를 가진 세션으로 작업을 편하게 이어갑니다';
const cwd = '/repository/' + 'a-long-directory-name/'.repeat(8);
const commands = [{ name: 'review', description: 'Review the working tree', input_hint: 'optional focus' }, { name: 'a-very-long-command-name-for-testing', description: 'A long command description' }];
const live = { manager_id: host.manager_id, manager_name: host.name, cli: 'codex', session_id: 'session-responsive', title, cwd, status: 'ready', available_modes: [], current_mode: null, available_commands: commands,
  config_options: [
    // Categories as adapters report them (ACP): effort is `thought_level`; `access` is an extra option the header folds into its menu.
    ...[['access', 'Access', 'Full access', 'access'], ['mode', 'Mode', 'Default', 'mode'], ['model', 'Model', '6.1 Sol', 'model'], ['effort', 'Effort', 'Ultra', 'thought_level']].map(([config_id, name, value, category]) => ({ config_id, name, type: 'select', category, current_value: value, options: [{ value, name: value }] })),
    { config_id: 'fast', name: 'Fast mode', type: 'boolean', current_value: false },
  ], auth: { source: 'credential', credential_name: 'ChatGPT Pro', account_email: 'long-account-name@example.test' }, updated_at: new Date().toISOString() };
const events = Array.from({ length: 16 }, (_, i) => ({ id: `event-${i}`, seq: i + 1, type: i % 2 ? 'text' : 'user_prompt', turn_id: `turn-${i}`, created_at: live.updated_at, payload: { text: i % 2 ? '작업 내용을 확인했습니다.\n\n```ts\nconst example = "a very long line of code that should scroll within its own container";\n```' : '모바일 화면에서 세션 UI를 확인해 주세요.' } }));
const project = { id: 'responsive-project', account_id: account.id, name: 'Responsive project', repo_url: 'https://example.test/' + 'long-repository-name'.repeat(8), default_branch: 'main', enabled: true };
const ticket = { id: 'responsive-ticket', account_id: account.id, parent_id: null, title, status: 'todo', priority: 'medium', tags: ['ui'], project_id: project.id, position: 0, assignee: null, assignee_key: '', created_at: live.updated_at, updated_at: live.updated_at, description: '반응형 티켓 상세를 확인합니다.', depth: 0, channel_ids: [], comments: [], children: [], attachments: [], prerequisites: [], prerequisite_count: 0, on_done_action_ids: [], next_ticket_id: null, created_by: 'Test user', created_by_type: 'user', created_by_id: 'user-test', project: null };
const room = { id: 'responsive-room', account_id: account.id, type: 'group', name: 'Responsive chat', created_at: live.updated_at, participants: [{ id: 'p1', participant_type: 'user', participant_id: 'user-test', participant_name: 'Test user' }], unread_count: 0, is_participant: true };
const mission = { id: 'mission', account_id: account.id, title, team_id: 'responsive-team', team_name: 'Responsive team', status: 'running', briefing: '반응형 미션 상세', acceptance_criteria: '', room_id: room.id, user_chat_mode: 'open', steps: [], events: [], graph_spec: null, step_timeout_minutes: 30, counts: { total: 0, done: 0, inFlight: 0, failed: 0, awaitingUser: 0, pending: 0 }, plan_version: 1, created_at: live.updated_at, started_at: live.updated_at };
const team = { id: 'responsive-team', account_id: account.id, name: 'Responsive team', enabled: true, members: [], orchestrator_spec: null };

async function fixture(page, { busy = false, withStep = false } = {}) {
  const errors = [];
  const prompts = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ accountId }) => {
    localStorage.setItem('auth_token', 'responsive-test-token');
    localStorage.setItem('currentAccountId', accountId);
    window.EventSource = class extends EventTarget { readyState = 1; close() { this.readyState = 2; } };
  }, { accountId: account.id });
  await page.route('**/api/**', async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace(/^\/api/, '');
    let body = [];
    if (path === '/auth/me') body = { id: 'user-test', name: 'Test user', email: 'test@example.test', role: 'admin', status: 'active', permissions: [], resolved_permissions: ['admin.access', 'admin.actions', 'agent_sessions.use', 'voice.use'], accounts: [account] };
    else if (path === '/cli-catalog') body = { clis: cliCatalog() };
    else if (path === '/auth/setup-status') body = { needs_setup: false };
    else if (path === '/accounts') body = [account];
    else if (path === `/accounts/${account.id}`) body = account;
    else if (path === '/admin/agent-manager/instances') body = [{ instance_id: 'instance', host_id: host.manager_id, agent_id: host.manager_id, agent_name: host.name, hostname: host.hostname, account_id: account.id, mode: 'manager', cli: 'mixed', cli_adapters: ['codex'], pid: 123, plugin_version: '1.0.0', started_at: live.updated_at, last_seen_at: live.updated_at, working_dirs: [], agent_ids: [] }];
    else if (path === '/voice/config') body = { stt: { provider: 'openai', ready: true }, tts: { provider: 'openai', ready: true }, wake: { ready: false } };
    else if (path === '/voice/operators') body = { operators: [] };
    else if (path === '/agent-sessions/hosts') body = [host];
    else if (path.endsWith('/prompt')) { prompts.push(req.postDataJSON()); body = { turn_id: 'sent', live: { ...live, status: 'busy' } }; }
    else if (path.endsWith('/session-responsive')) body = { session: live, live: { ...live, status: busy ? 'busy' : 'ready' }, events };
    else if (path.endsWith('/sessions')) body = [live];
    else if (path.endsWith('/settings') && path.startsWith('/agent-sessions/')) body = { manager_id: host.manager_id, cli: 'codex', credential: null, candidates: [], default_config: {}, known_config_options: live.config_options };
    else if (path.endsWith('/models')) body = { models: ['6.1 Sol'], models_by_cli: { codex: ['6.1 Sol'] }, labels: {}, available_models_at: live.updated_at };
    else if (path === '/chat-rooms') body = [room];
    else if (path === '/chat-rooms/responsive-room') body = room;
    else if (path.includes('/mention-candidates')) body = { users: [], agents: [] };
    else if (path.includes('/presence')) body = { viewers: [] };
    else if (path === '/tickets/responsive-ticket') body = ticket;
    else if (path === '/projects' || path.endsWith('/projects')) body = [project];
    else if (path === '/agent-templates/hosts') body = [{ id: host.manager_id, name: host.name }];
    else if (path === '/orchestration/missions/mission') body = withStep ? { ...mission, steps: [{ id: 'step-review', step_key: 'review', title: '모바일에서 단계 세션 보기', instructions: 'Check the responsive UI', acceptance_criteria: '', depends_on: [], assignee_name: 'Ralf', assignee_online: true, status: 'running', position: 0, plan_version: 1, room_id: room.id, result_summary: '', artifacts: [], attempt: 1, max_attempts: 2, workspace_folder: cwd, visit: 1, verdict: '', retry_policy: 'auto', recovery_reason: '', last_heartbeat_at: null, confirm_decision: null, activity: null }], counts: { ...mission.counts, total: 1, inFlight: 1 } } : mission;
    else if (path === '/orchestration/missions/mission/events') body = { events: [], has_more: false, next_cursor: null };
    else if (path === '/orchestration/teams') body = [team];
    else if (path === '/orchestration/missions') body = [{ id: 'mission', title, team_name: team.name, status: 'running', counts: { total: 4, done: 1, inFlight: 2, failed: 0, awaitingUser: 1 }, plan_version: 1, created_at: live.updated_at, started_at: live.updated_at, live_steps: [] }];
    else if (path === '/claude-backend-profiles' || path === '/admin/claude-backend-profiles') body = { profiles: [], default_profile_id: null };
    else if (path.endsWith('/tickets')) body = { tickets: [ticket], tags: [{ tag: 'ui', count: 1 }] };
    else if (path.includes('/unread') || path.endsWith('counts') || path.includes('/mentions')) body = { count: 0, total: 0, items: [], perRoom: {}, perTicket: {} };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return { errors, prompts };
}

async function expectFits(page) {
  const overflow = await page.evaluate(() => {
    return [document.documentElement, ...document.querySelectorAll('.awb-content, .awb-ticket-detail, .awb-session-transcript')].filter(Boolean).map(el => ({ width: el.clientWidth, scroll: el.scrollWidth }));
  });
  for (const el of overflow) expect(el.scroll, page.url()).toBeLessThanOrEqual(el.width + 1);
}

for (const size of [{ width: 320, height: 568 }, { width: 360, height: 740 }, { width: 390, height: 844 }, { width: 430, height: 932 }, { width: 768, height: 1024 }, { width: 1024, height: 768 }, { width: 1100, height: 800 }, { width: 1101, height: 800 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }, { width: 667, height: 375 }]) {
  test(`session composer and transcript fit ${size.width}×${size.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(size);
    const f = await fixture(page, { busy: size.width === 320 });
    await page.goto(sessionPath);
    const input = page.getByRole('textbox', { name: 'Prompt', exact: true });
    await expect(input).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start conversation mode', exact: true })).toBeVisible();
    const box = await input.boundingBox();
    const content = await page.locator('.awb-content').boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(Math.min(280, content.width - 32));
    expect(box.height).toBeLessThanOrEqual(90);
    expect(box.y + box.height).toBeLessThanOrEqual(size.height);
    await expectFits(page);
    await input.fill('/');
    await expect(page.getByRole('listbox', { name: 'Slash commands' })).toBeVisible();
    await expectFits(page);
    await input.fill('반응형 전송 확인');
    await page.getByRole('button', { name: size.width === 320 ? 'Queue' : 'Send', exact: true }).click();
    if (size.width === 320) await expect(page.getByLabel('Queued prompts')).toContainText('반응형 전송 확인');
    else await expect.poll(() => f.prompts.length).toBe(1);
    expect(f.errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('session.png') });
  });
}

for (const width of [320, 768, 1440]) {
test(`main pages and new-session dialog fit width ${width}`, async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width, height: 800 });
  const f = await fixture(page);
  for (const route of ['/sessions', `/sessions/${host.manager_id}`, '/tickets', '/tickets?ticket=responsive-ticket', '/projects', '/projects?project=responsive-project', '/missions', '/missions/mission', '/teams', '/chat', '/chat/responsive-room', '/hosts', '/terminals', '/settings', '/settings/ownership', '/settings/members', '/settings/credentials', '/settings/channels', '/settings/api-keys', '/settings/claude-profiles']) {
    await page.goto(route);
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await page.waitForTimeout(180);
    await expectFits(page);
    if (route.includes('ticket=') && width < 1101) {
      const detail = await page.getByRole('region', { name: 'Ticket detail' }).boundingBox();
      expect(detail.width).toBe(width < 768 ? width : width - 288);
      await expect(page.getByRole('button', { name: 'Close ticket' })).toBeVisible();
    }
    if (route === '/missions/mission' || route === '/chat/responsive-room') {
      const input = page.getByRole('textbox', { name: 'Message', exact: true });
      await expect(input).toBeVisible();
      const rect = await input.boundingBox();
      expect(rect.width).toBeGreaterThanOrEqual(Math.min(280, width - 32));
      await input.fill('채팅과 미션에서도 넓게 입력합니다');
    }
    expect(f.errors, route).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`${route.split('/').filter(Boolean).join('-')}.png`) });
  }
  await page.goto('/sessions?new=1');
  const dialog = page.getByRole('dialog', { name: 'New session', exact: true });
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
  await expectFits(page);
});
}


test('mobile header keeps Mode/Model/Effort visible, folds the rest into the menu, and resizing preserves the draft', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await fixture(page);
  await page.goto(sessionPath);
  const input = page.getByRole('textbox', { name: 'Prompt', exact: true });
  await input.fill('회전해도 작성 중인 내용은 유지합니다');
  // 매 턴 보는 설정은 토글 없이 헤더에 있다.
  for (const name of ['Mode', 'Model', 'Effort']) await expect(page.getByRole('combobox', { name, exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Model', exact: true }).selectOption('6.1 Sol');
  // 폴더 · 세션 정보 · 그 밖의 설정 · 동작은 햄버거 메뉴에 있다.
  await expect(page.getByText(cwd, { exact: true })).toBeHidden();
  const menu = page.getByRole('button', { name: 'Session menu', exact: true });
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  const panel = page.locator('.awb-session-menu-panel');
  await expect(panel.getByText(cwd, { exact: true })).toBeVisible();
  await expect(panel.getByRole('combobox', { name: 'Access', exact: true })).toBeVisible();
  await expect(panel.getByRole('checkbox', { name: 'Fast mode', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: /Restart process/ })).toBeVisible();
  const panelBox = await panel.boundingBox();
  expect(panelBox.x).toBeGreaterThanOrEqual(0);
  expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(390);
  await expectFits(page);
  await page.screenshot({ path: testInfo.outputPath('session-menu-open.png') });
  await page.keyboard.press('Escape');
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  for (const size of [{ width: 667, height: 375 }, { width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    await expect(input).toHaveValue('회전해도 작성 중인 내용은 유지합니다');
    await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toBeVisible();
    await expectFits(page);
    const box = await input.boundingBox();
    expect(box.y + box.height).toBeLessThanOrEqual(size.height);
  }
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.getByRole('dialog', { name: 'Navigation', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Navigation', exact: true })).toBeHidden();
  expect(f.errors).toEqual([]);
});

test('composer follows a keyboard-sized visual viewport without applying pinch zoom', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const viewport = new EventTarget();
    Object.assign(viewport, { height: 844, width: 390, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });
    window.resizeVisualViewport = (height, scale = 1) => {
      Object.assign(viewport, { height, scale });
      viewport.dispatchEvent(new Event('resize'));
    };
  });
  await fixture(page);
  await page.goto(sessionPath);
  const input = page.getByRole('textbox', { name: 'Prompt', exact: true });
  await input.fill('키보드가 열려도 입력창이 보입니다');
  await page.evaluate(() => window.resizeVisualViewport(390));
  await expect.poll(async () => (await page.getByTestId('app-shell').boundingBox()).height).toBe(390);
  const box = await input.boundingBox();
  expect(box.y + box.height).toBeLessThanOrEqual(390);
  await page.evaluate(() => window.resizeVisualViewport(195, 2));
  await expect.poll(async () => (await page.getByTestId('app-shell').boundingBox()).height).toBe(390);
  await page.evaluate(() => window.resizeVisualViewport(844));
  await expect.poll(async () => (await page.getByTestId('app-shell').boundingBox()).height).toBe(844);
  await page.goto('/sessions?new=1');
  const dialog = page.getByRole('dialog', { name: 'New session', exact: true });
  await expect(dialog).toBeVisible();
  await page.evaluate(() => window.resizeVisualViewport(390));
  await expect.poll(async () => { const rect = await dialog.boundingBox(); return rect.y >= 0 && rect.y + rect.height <= 390; }).toBe(true);
});


test('mobile ticket links open the editor and host details have a way back', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = await fixture(page);
  await page.goto('/chat?ticket=responsive-ticket');
  const preview = page.getByRole('dialog', { name: '티켓 상세', exact: true });
  await expect(preview).toBeVisible();
  await preview.getByRole('button', { name: '티켓 열기', exact: true }).click();
  await expect(page).toHaveURL(/\/tickets\?ticket=responsive-ticket$/);
  await expect(page.getByRole('region', { name: 'Ticket detail' })).toBeVisible();
  await expect(preview).toBeHidden();
  await page.getByRole('button', { name: 'Close ticket' }).click();
  await expect(page).toHaveURL(/\/tickets$/);
  await page.goto('/hosts');
  await page.getByTestId('runtime-hosts-list').getByRole('button').filter({ hasText: 'Ralf' }).click();
  await expect(page.getByRole('button', { name: '← Host 목록', exact: true })).toBeVisible();
  await expectFits(page);
  await page.getByRole('button', { name: '← Host 목록', exact: true }).click();
  await expect(page.getByTestId('runtime-hosts-list')).toBeVisible();
  expect(f.errors).toEqual([]);
});


for (const width of [320, 768]) {
  test(`mission step navigation preserves readable content at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const f = await fixture(page, { withStep: true });
    await page.goto('/missions/mission');
    const toggle = page.getByRole('button', { name: 'Steps (1)' });
    await toggle.click();
    const rail = page.getByTestId('mission-step-rail');
    await expect(rail).toBeVisible();
    const railBox = await rail.boundingBox();
    expect(railBox.width).toBeGreaterThanOrEqual(280);
    await page.getByTestId('rail-step-row').click();
    await expect(rail).toBeHidden();
    await expect(page.getByTestId('step-session')).toBeVisible();
    await expectFits(page);
    await page.getByRole('button', { name: 'Back to mission', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
    expect(f.errors).toEqual([]);
  });
}
