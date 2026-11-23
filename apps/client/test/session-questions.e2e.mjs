import { test, expect } from '@playwright/test';
import { cliCatalog } from '../src/cli/catalog.ts';
import { codexAsyncQuestion } from '../../agent-manager/src/lib/clis/codex/async-questions.ts';

async function fixture(page) {
  const account = { id: 'question-account', name: 'Personal', owner_user_id: 'question-user' };
  const host = { manager_id: 'question-host', instance_id: 'instance', hostname: 'host', name: 'Host',
    clis: ['codex'], last_seen_at: new Date().toISOString() };
  let stamp = Date.now();
  let live = { manager_id: host.manager_id, manager_name: 'Host', cli: 'codex', session_id: 'question-session',
    title: 'Async question', cwd: '/repo', status: 'busy', available_modes: [], current_mode: null,
    config_options: [], available_commands: [], pending_permissions: [], pending_elicitations: [],
    updated_at: new Date(stamp).toISOString() };
  const question = codexAsyncQuestion({ type: 'event_msg', payload: { type: 'item_completed', item: {
    type: 'AgentMessage', id: 'call-question', delivery: 'async',
    content: [{ type: 'Text', text: '요약 방식?\n- 짧게\n- 자세히' }], questions: [{ title: '요약 방식?', options: ['짧게', '자세히'] }],
  } } });
  const event = (type, payload) => ({ id: `event-${++stamp}`, seq: stamp, type, payload, turn_id: 'asking-turn', created_at: new Date(stamp).toISOString() });
  const events = [
    event('tool_call', { tool_call_id: question.toolCallId, title: 'request_user_input_async', status: 'completed' }),
    event('text', { text: question.echoText }),
    event('elicitation_request', { elicitation_id: question.id, tool_call_id: question.toolCallId, echo_text: question.echoText,
      mode: 'form', async: true, message: question.message, schema: question.schema }),
  ];
  const answers = [];
  await page.addInitScript(accountId => {
    localStorage.setItem('locale', 'en');
    localStorage.setItem('auth_token', 'question-browser-test');
    localStorage.setItem('currentAccountId', accountId);
    window.EventSource = class extends EventTarget {
      readyState = 1;
      constructor() { super(); window.questionTestStream = this; }
      close() { this.readyState = 2; }
    };
  }, account.id);
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '');
    let body = [];
    if (path === '/auth/me') body = { id: 'question-user', name: 'User', role: 'admin', status: 'active',
      resolved_permissions: ['agent_sessions.use'], accounts: [account] };
    else if (path === '/auth/setup-status') body = { needs_setup: false };
    else if (path === '/cli-catalog') body = { clis: cliCatalog() };
    else if (path === '/accounts') body = [account];
    else if (path === '/agent-sessions/hosts') body = [host];
    else if (path.endsWith('/question-session/usage-limits')) body = { events: [] };
    else if (path.endsWith('/sessions/question-session')) body = { session: live, live, events, next_before: null };
    else if (path.endsWith('/question-session/elicitation')) {
      expect(route.request().method()).toBe('POST');
      answers.push(route.request().postDataJSON());
      body = live;
    }
    else if (path.endsWith('/sessions')) body = [live];
    else if (path === '/voice/config') body = { stt: { ready: false }, tts: { ready: false }, wake: { ready: false } };
    else if (path === '/voice/operators') body = { operators: [] };
    else if (path.endsWith('/models')) body = { models: [] };
    else if (path.includes('/unread') || path.includes('/counts')) body = { count: 0, total: 0, items: [], perRoom: {}, perTicket: {} };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const emit = (type, data) => page.evaluate(({ type, data }) => window.questionTestStream.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) })), { type, data });
  await page.goto(`/sessions/${host.manager_id}/codex/${live.session_id}`);
  return {
    answers,
    async status(status) {
      live = { ...live, status, updated_at: new Date(++stamp).toISOString() };
      await emit('agent_session_update', { session: live });
    },
    async finish() {
      const done = event('turn', { phase: 'finished', stop_reason: 'end_turn' });
      events.push(done);
      await emit('agent_session_event', { manager_id: host.manager_id, cli: 'codex', session_id: live.session_id, event: done });
      await this.status('ready');
    },
    async decide() {
      const decision = event('elicitation_decision', { ...answers.at(-1), decided_by: 'user' });
      events.push(decision);
      await emit('agent_session_event', { manager_id: host.manager_id, cli: 'codex', session_id: live.session_id, event: decision });
    },
  };
}

for (const width of [1280, 390]) {
  for (const when of ['after turn end', 'after reload', 'selected before turn end']) {
    test(`async question accepts an answer ${when} at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const f = await fixture(page);
      const card = page.locator('[data-block="elicitation"]');
      const select = card.getByRole('combobox', { name: '요약 방식?' });
      const submit = card.getByRole('button', { name: 'Submit', exact: true });
      await expect(card).toHaveCount(1);
      await expect(select).toBeEnabled();
      await expect(submit).toBeDisabled();
      if (when === 'selected before turn end') await select.selectOption('짧게');
      await f.finish();
      if (when === 'after reload') await page.reload();
      await expect(card).toHaveCount(1);
      await expect(select).toBeEnabled();
      if (when !== 'selected before turn end') await select.selectOption('짧게');
      await expect(select).toHaveValue('짧게');
      await expect(submit).toBeEnabled();
      await expect(card).not.toContainText('Session is not live');
      await submit.click();
      await expect.poll(() => f.answers).toEqual([{ elicitation_id: 'call-question', action: 'accept', content: { q_1: '짧게' } }]);
      await f.decide();
      await expect(card.locator('form')).toHaveCount(0);
      await expect(card).toContainText('짧게');
      await page.reload();
      await expect(card).toHaveCount(1);
      await expect(card.locator('form')).toHaveCount(0);
    });
  }
}

test('a stopped session keeps unanswered question controls disabled', async ({ page }) => {
  const f = await fixture(page);
  const card = page.locator('[data-block="elicitation"]');
  const select = card.getByRole('combobox', { name: '요약 방식?' });
  await expect(select).toBeEnabled();
  await f.status('closed');
  await expect(select).toBeDisabled();
  await expect(card.getByRole('button', { name: 'Submit', exact: true })).toBeDisabled();
  expect(f.answers).toHaveLength(0);
});
