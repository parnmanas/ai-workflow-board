// Real Chromium + getUserMedia + Silero VAD. STT and session APIs are stubbed:
// this tests microphone readiness and routing, not recognition accuracy.
// VOICE_TEST_WAV=/absolute/path/to/speech-with-silence.wav CHROME_PATH=/usr/bin/google-chrome
// PLAYWRIGHT_TEST_MATCH=voice-notification.e2e.mjs npm --workspace client run test:e2e
import { test, expect } from '@playwright/test';

const wav = process.env.VOICE_TEST_WAV;
test.skip(!wav, 'Provide a speech WAV for Chromium fake microphone capture');
test.use({ launchOptions: {
  executablePath: process.env.CHROME_PATH || undefined,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=user-gesture-required'],
} });

const workspace = { id: 'ws-voice-test', name: 'Voice Test', relations: ['admin'] };
const operator = { id: 'op-test', name: 'Jarvis', aliases: [], manager_id: 'host-test', cli: 'claude', session_id: 'operator-session', cwd: '/tmp', title: 'Operator' };
const operatorPath = `/ws/${workspace.id}/sessions/${operator.manager_id}/${operator.cli}/${operator.session_id}`;

async function fixture(page, suspendOnPermission = false, initialPath = `/ws/${workspace.id}/sessions`) {
  const prompts = [];
  const transcripts = [];
  const errors = [];
  let recognizeReport = true;
  page.on('pageerror', (error) => errors.push(error.message));
  await page.context().grantPermissions(['microphone']);
  await page.addInitScript(({ workspaceId, suspendOnPermission }) => {
    localStorage.setItem('auth_token', 'voice-test-token');
    localStorage.setItem('currentWorkspaceId', workspaceId);
    localStorage.setItem('awb.voice.wake', '0');
    window.__voiceStreams = [];
    window.__voiceContexts = [];
    const NativeAudioContext = window.AudioContext;
    window.AudioContext = class extends NativeAudioContext {
      constructor(...args) { super(...args); window.__voiceContexts.push(this); }
    };
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (...args) => {
      const stream = await getUserMedia(...args);
      if (suspendOnPermission) await window.__voiceContexts.at(-1)?.suspend();
      window.__voiceStreams.push(stream);
      return stream;
    };
    const sources = [];
    window.EventSource = class extends EventTarget {
      readyState = 1;
      constructor() { super(); sources.push(this); setTimeout(() => this.onopen?.(new Event('open')), 0); }
      close() { this.readyState = 2; }
    };
    window.__voiceAnnouncement = (data) => sources.filter((source) => source.readyState === 1)
      .forEach((source) => source.dispatchEvent(new MessageEvent('voice_announcement', { data: JSON.stringify(data) })));
  }, { workspaceId: workspace.id, suspendOnPermission });
  const live = { manager_id: operator.manager_id, cli: operator.cli, session_id: operator.session_id, status: 'ready',
    title: 'Operator', cwd: '/tmp', available_modes: [], current_mode: null, config_options: [], available_commands: [],
    updated_at: new Date().toISOString(), driver_user_id: 'user-test' };
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api/, '');
    let body = [];
    if (path === '/voice/transcribe') {
      transcripts.push({ purpose: url.searchParams.get('purpose'), bytes: req.postDataBuffer().length });
      body = recognizeReport ? { text: '보고해', provider: 'local', latency_ms: 1 }
        : { text: '', provider: 'local', ignored: 'speaker_mismatch', latency_ms: 1 };
    } else if (path.endsWith('/prompt')) {
      prompts.push({ path, ...JSON.parse(req.postData()) });
      body = { turn_id: `turn-${prompts.length}`, live: { ...live, status: 'busy' } };
    } else if (path === '/auth/me') body = { id: 'user-test', name: 'Test', role: 'admin', status: 'active', permissions: [],
      resolved_permissions: ['admin.access', 'agent_sessions.use', 'voice.use'], workspaces: [workspace] };
    else if (path === '/auth/setup-status') body = { needs_setup: false };
    else if (path === '/workspaces') body = [workspace];
    else if (path === `/workspaces/${workspace.id}`) body = workspace;
    else if (path === '/voice/config') body = { stt: { provider: 'local', ready: true }, tts: { provider: 'none', ready: false }, wake: { ready: true } };
    else if (path === '/voice/operators') body = { operators: [operator] };
    else if (path.includes('unread') || path.includes('count') || path.includes('mentions')) body = { count: 0, total: 0, items: [], perRoom: {}, perTicket: {} };
    else if (path === '/agent-sessions/hosts') body = [{ manager_id: operator.manager_id, name: 'Test', connected: true, clis: ['claude'], acp_session_clis: ['claude'], cli_settings: {} }];
    else if (path.startsWith(`/agent-sessions/hosts/${operator.manager_id}/claude/sessions/${operator.session_id}`)) body = {
      session: { session_id: operator.session_id, title: 'Operator', cwd: '/tmp', updated_at: live.updated_at, cli: 'claude', manager_id: operator.manager_id }, live, events: [],
    };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto(initialPath);
  await expect(page.locator('[data-wake-listener]')).toHaveAttribute('data-wake-listener', 'off');
  await page.mouse.click(650, 350); // Genuine user activation; autoplay restrictions remain enabled.
  const announce = () => page.evaluate(({ operator }) => window.__voiceAnnouncement({ id: `notice-${Date.now()}`,
    user_id: 'user-test', kind: 'operator_report', text: 'A question is ready', operator: { id: operator.id, name: operator.name },
    needs_decision: true, target: { type: 'session', manager_id: operator.manager_id, cli: 'codex', session_id: 'source-session' },
  }), { operator });
  return { prompts, transcripts, errors, announce, rejectSpeaker: () => { recognizeReport = false; }, acceptSpeaker: () => { recognizeReport = true; } };
}

test('a cue starts the microphone after a 20-second cold model load and 보고해 reaches the operator', async ({ page }) => {
  test.setTimeout(75_000);
  const f = await fixture(page, true);
  let modelRequested = false;
  await page.route('**/vad/*.onnx', async (route) => {
    if (!modelRequested) {
      modelRequested = true;
      await new Promise((resolve) => setTimeout(resolve, 20_000));
    }
    await route.continue();
  });
  await f.announce();
  await expect.poll(() => modelRequested).toBe(true);
  await page.waitForTimeout(16_000);
  await expect(page.locator('[data-wake-listener]')).not.toHaveAttribute('data-wake-listener', 'off');
  await expect.poll(() => f.prompts.length, { timeout: 35_000 }).toBe(1);
  expect(f.transcripts[0].purpose).toBe('wake');
  expect(f.transcripts[0].bytes).toBeGreaterThan(1000);
  expect(f.prompts[0].path).toContain('/claude/sessions/operator-session/prompt');
  expect(f.prompts[0].text).toContain('보고해');
  await expect(page).toHaveURL(new RegExp(`${operatorPath}$`));
  await expect(page.locator('[data-conversation-phase]')).toHaveAttribute('data-conversation-phase', 'listening');
  expect(await page.evaluate(() => window.__voiceContexts.some((context) => context.state === 'running'))).toBe(true);
  expect(f.errors).toEqual([]);
});

test('after automatic input times out, manually enabling the microphone accepts 보고해 and exposes speaker rejection', async ({ page }) => {
  test.setTimeout(75_000);
  const f = await fixture(page);
  f.rejectSpeaker();
  await f.announce();
  await expect.poll(() => f.transcripts.length, { timeout: 25_000 }).toBeGreaterThan(0);
  await expect(page.locator('[data-wake-listener]')).toHaveAttribute('aria-label', /등록한 내 목소리/);
  await expect(page.locator('[data-wake-listener]')).toHaveAttribute('data-wake-listener', 'off', { timeout: 25_000 });
  expect(f.prompts).toHaveLength(0);
  await expect.poll(() => page.evaluate(() => window.__voiceStreams.every((stream) => stream.getTracks().every((track) => track.readyState === 'ended')))).toBe(true);
  f.acceptSpeaker();
  await page.locator('[data-wake-listener]').click();
  await expect.poll(() => f.prompts.length, { timeout: 20_000 }).toBe(1);
  expect(f.prompts[0].path).toContain('/claude/sessions/operator-session/prompt');
  expect(f.prompts[0].text).toContain('보고해');
  await expect(page).toHaveURL(new RegExp(`${operatorPath}$`));
  expect(f.errors).toEqual([]);
});

test('the operator composer microphone resumes audio, explains speaker rejection and sends 보고해 directly', async ({ page }) => {
  test.setTimeout(45_000);
  const f = await fixture(page, true, operatorPath);
  f.rejectSpeaker();
  await page.getByRole('button', { name: 'Start conversation mode', exact: true }).click();
  await expect(page.locator('[data-conversation-phase]')).toHaveAttribute('data-conversation-phase', 'listening', { timeout: 15_000 });
  const rejection = page.getByRole('status').filter({ hasText: /등록한 내 목소리와 일치하지 않아/ });
  await expect(rejection).toBeVisible({ timeout: 15_000 });
  expect(f.prompts).toHaveLength(0);
  expect(f.transcripts.every((transcript) => transcript.purpose === null)).toBe(true, 'the composer uses utterance STT, not sidebar name calling');
  await expect(page.locator('[data-wake-listener]')).toHaveAttribute('data-wake-listener', 'off');
  f.acceptSpeaker();
  await expect.poll(() => f.prompts.length, { timeout: 15_000 }).toBe(1);
  expect(f.prompts[0].path).toContain('/claude/sessions/operator-session/prompt');
  expect(f.prompts[0].text).toBe('보고해');
  await expect(rejection).toHaveCount(0);
  await page.getByRole('button', { name: 'Stop conversation mode', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start conversation mode', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__voiceStreams.every((stream) => stream.getTracks().every((track) => track.readyState === 'ended')))).toBe(true);
  expect(f.errors).toEqual([]);
});
