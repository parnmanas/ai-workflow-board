import { test, expect } from '@playwright/test';
import { cliCatalog } from '../src/cli/catalog.ts';

async function fixture(page) {
  const account = { id: 'chat-account', name: 'Personal', owner_user_id: 'chat-user' };
  const name = 'Runtime Host / Writer with a very long agent nickname that wraps on small screens';
  const participants = [
    { id: 'user-row', participant_id: 'chat-user', participant_type: 'user', name: 'Human' },
    { id: 'agent-row', participant_id: 'rt-agent', participant_type: 'agent', name, nickname: 'Writer', has_runtime_settings: true },
  ];
  const room = { id: 'settings-room', account_id: account.id, type: 'dm', name: 'Settings test', dm_partner_name: name,
    participant_count: 2, participants, unread_count: 0, can_edit_agent_settings: true, can_edit_agent_nicknames: true, can_remove_participants: true };
  let settings = { participant_row_id: 'agent-row', participant_id: 'rt-agent', host_name: 'Runtime Host', revision: 'r1', can_restart: true,
    runtime: { manager_agent_id: 'host', cli: 'claude', model: 'model-a', credential_id: null, cli_runtime_profile: null,
      working_dir: '/work', role_prompt: '', label: 'Writer', runtime_config: { strategy: 'single', permission_mode: 'strict' } },
    connection_settings: { manager_id: 'host', cli: 'claude', supports_credential: true, credential: null,
      candidates: [{ id: 'new-credential', name: 'Another login', provider: 'claude_api_key' }], supports_backend: true,
      backend: null, backend_candidates: [], default_config: {}, known_config_options: [] } };
  const restarts = [];
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(id => {
    localStorage.setItem('locale', 'en'); localStorage.setItem('auth_token', 'fixture'); localStorage.setItem('currentAccountId', id);
    window.EventSource = class extends EventTarget { readyState = 1; close() { this.readyState = 2; } };
  }, account.id);
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '');
    let body = [];
    if (path === '/auth/me') body = { id: 'chat-user', name: 'Human', role: 'user', status: 'active', resolved_permissions: ['chat.view', 'chat.send'], accounts: [account] };
    else if (path === '/auth/setup-status') body = { needs_setup: false };
    else if (path === '/accounts') body = [account];
    else if (path === '/cli-catalog') body = { clis: cliCatalog() };
    else if (path === '/chat-rooms') body = [room];
    else if (path === '/chat-rooms/settings-room') body = room;
    else if (path.endsWith('/agents/agent-row/settings')) body = settings;
    else if (path.endsWith('/agents/agent-row/restart')) {
      const input = route.request().postDataJSON();
      restarts.push({ ...input, account: route.request().headers()['x-account-id'] });
      settings = { ...settings, revision: 'r2', runtime: { ...settings.runtime, ...input.settings }, application: 'restarted' }; body = settings;
    }
    else if (path.endsWith('/models')) body = { manager_agent_id: 'host', is_online: true, models: { claude: ['model-a', 'model-b'] }, refreshed_at: new Date().toISOString() };
    else if (path === '/voice/config') body = { stt: { ready: false }, tts: { ready: false }, wake: { ready: false } };
    else if (path === '/voice/operators') body = { operators: [] };
    else if (path.includes('/unread') || path.includes('/counts')) body = { count: 0, total: 0, items: [], perRoom: {}, perTicket: {} };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/chat/settings-room');
  return { name, restarts, errors };
}

for (const viewport of [{ width: 320, height: 568 }, { width: 768, height: 1024 }, { width: 667, height: 375 }]) {
  test(`agent settings, confirmation and participant actions remain reachable at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const { name, restarts, errors } = await fixture(page);
    await page.getByRole('button', { name: 'Manage participants', exact: true }).first().click();
    const participants = page.getByRole('dialog', { name: 'Participants', exact: true });
    const settingsButton = participants.getByRole('button', { name: `Settings for ${name}`, exact: true });
    await expect(settingsButton).toBeInViewport();
    await expect(participants.getByRole('button', { name: `Edit nickname for ${name}` })).toBeInViewport();
    await expect(participants.getByRole('button', { name: `Remove ${name} from this room` })).toBeInViewport();
    await settingsButton.click();
    const editor = page.getByRole('dialog', { name: 'Agent settings', exact: true });
    const credential = editor.getByRole('combobox', { name: 'Session credential', exact: true });
    await credential.selectOption('new-credential');
    await expect(credential).toHaveValue('new-credential');
    const save = editor.getByRole('button', { name: 'Save settings', exact: true });
    await expect(save).toBeInViewport(); await save.click();
    const confirm = page.getByRole('dialog', { name: 'Restart required', exact: true });
    await expect(confirm.getByText(/active turn will be interrupted/)).toBeInViewport();
    await expect(confirm.getByRole('button', { name: 'Yes, restart', exact: true })).toBeInViewport();
    await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(restarts).toEqual([]);
    await save.click(); await confirm.getByRole('button', { name: 'Yes, restart', exact: true }).click();
    await expect(editor.getByRole('button', { name: 'Restart process', exact: true })).toBeEnabled();
    expect(restarts).toHaveLength(1);
    expect(restarts[0].account).toBe('chat-account');
    expect(restarts[0].expected_revision).toBe('r1');
    expect(restarts[0].settings.credential_id).toBe('new-credential');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('chat-agent-settings.png') });
  });
}
