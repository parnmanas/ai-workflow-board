// Workspace "Ticket dispatch" settings (docs/tickets.md → Workspace settings).
// The settings moved here from boards: language, max concurrent tickets per
// agent, done-ticket auto-archive and the dispatch pause switch.
//
// Pins the PATCH /workspaces/:id body the section sends: only changed keys,
// blank language / auto-archive → null, validation (int ≥ 1, 1..365), and the
// pause switch stamping an ISO "now" / null. The last test mounts the real
// section and checks what reaches api.updateWorkspace.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDispatchPausePatch,
  buildDispatchSettingsPatch,
  dispatchSettingsToForm,
  isDispatchPaused,
  validateDispatchSettings,
} from '../src/components/workspaceSettings.logic.ts';
import { setupDom, mount, click, typeInto, React, act } from './helpers/jsdom.mjs';
import { api } from '../src/api.ts';
import { TicketDispatchSettings } from '../src/components/WorkspaceSettingsPage.tsx';

const STORED = {
  language: 'Korean',
  max_concurrent_tickets_per_agent: 2,
  auto_archive_days: 14,
  dispatch_paused_at: null,
};

test('form reads the stored workspace; missing values fall back to defaults', () => {
  assert.deepEqual(dispatchSettingsToForm(STORED), { language: 'Korean', maxConcurrent: '2', autoArchiveDays: '14' });
  assert.deepEqual(dispatchSettingsToForm({}), { language: '', maxConcurrent: '1', autoArchiveDays: '' });
  assert.deepEqual(
    dispatchSettingsToForm({ language: null, max_concurrent_tickets_per_agent: 0, auto_archive_days: null }),
    { language: '', maxConcurrent: '1', autoArchiveDays: '' },
  );
});

test('unchanged form → empty patch (Save stays disabled)', () => {
  const { patch, errors } = buildDispatchSettingsPatch(dispatchSettingsToForm(STORED), STORED);
  assert.deepEqual(errors, {});
  assert.deepEqual(patch, {});
});

test('only changed keys are sent', () => {
  const form = { ...dispatchSettingsToForm(STORED), maxConcurrent: '3' };
  assert.deepEqual(buildDispatchSettingsPatch(form, STORED).patch, { max_concurrent_tickets_per_agent: 3 });
});

test('blank language and blank auto-archive are sent as null', () => {
  const form = { language: '   ', maxConcurrent: '2', autoArchiveDays: '' };
  assert.deepEqual(buildDispatchSettingsPatch(form, STORED).patch, { language: null, auto_archive_days: null });
});

test('language is trimmed; whitespace-only edits of the same value are not a change', () => {
  assert.deepEqual(buildDispatchSettingsPatch({ ...dispatchSettingsToForm(STORED), language: ' Korean ' }, STORED).patch, {});
  assert.deepEqual(
    buildDispatchSettingsPatch({ ...dispatchSettingsToForm(STORED), language: ' English ' }, STORED).patch,
    { language: 'English' },
  );
});

test('max concurrent must be a whole number 1..50 (server bound)', () => {
  for (const bad of ['', '0', '-1', '1.5', '2x', '1e2', ' ', '51']) {
    const errors = validateDispatchSettings({ language: '', maxConcurrent: bad, autoArchiveDays: '' });
    assert.ok(errors.maxConcurrent, `"${bad}" must be rejected`);
  }
  assert.deepEqual(validateDispatchSettings({ language: '', maxConcurrent: ' 4 ', autoArchiveDays: '' }), {});
  assert.deepEqual(validateDispatchSettings({ language: '', maxConcurrent: '50', autoArchiveDays: '' }), {});
});

test('auto-archive days: blank = disabled, else 1..365', () => {
  for (const bad of ['0', '366', '-3', '7.5', 'week']) {
    const errors = validateDispatchSettings({ language: '', maxConcurrent: '1', autoArchiveDays: bad });
    assert.ok(errors.autoArchiveDays, `"${bad}" must be rejected`);
  }
  for (const ok of ['', '1', '365', ' 30 ']) {
    assert.deepEqual(validateDispatchSettings({ language: '', maxConcurrent: '1', autoArchiveDays: ok }), {}, `"${ok}"`);
  }
  assert.deepEqual(
    buildDispatchSettingsPatch({ language: 'Korean', maxConcurrent: '2', autoArchiveDays: '30' }, STORED).patch,
    { auto_archive_days: 30 },
  );
});

test('invalid form returns errors and no patch', () => {
  const { patch, errors } = buildDispatchSettingsPatch({ language: 'x', maxConcurrent: '0', autoArchiveDays: '999' }, STORED);
  assert.deepEqual(patch, {});
  assert.ok(errors.maxConcurrent);
  assert.ok(errors.autoArchiveDays);
});

test('pause stamps an ISO "now"; resume clears it', () => {
  const now = new Date('2026-10-05T01:02:03.000Z');
  assert.deepEqual(buildDispatchPausePatch(true, now), { dispatch_paused_at: '2026-10-05T01:02:03.000Z' });
  assert.deepEqual(buildDispatchPausePatch(false, now), { dispatch_paused_at: null });
  assert.equal(isDispatchPaused({ dispatch_paused_at: '2026-10-05T01:02:03.000Z' }), true);
  assert.equal(isDispatchPaused({ dispatch_paused_at: null }), false);
  assert.equal(isDispatchPaused(null), false);
});

// ── Mounted section ──────────────────────────────────────────────────────────

const flush = async () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

function inputByLabel(root, text) {
  const label = [...root.querySelectorAll('label')].find((l) => l.textContent?.trim() === text);
  assert.ok(label, `"${text}" label missing`);
  return label.parentElement.querySelector('input');
}

test('Ticket dispatch section PATCHes only the changed keys and the pause switch on its own', async (t) => {
  const dom = setupDom();
  const calls = [];
  const original = api.updateWorkspace;
  api.updateWorkspace = async (id, data) => { calls.push({ id, data }); return { ...workspace, ...data }; };
  t.after(() => { api.updateWorkspace = original; });

  const workspace = { id: 'ws-1', name: 'W', description: '', created_at: '', updated_at: '', ...STORED };
  let current = workspace;
  const view = mount(React.createElement(TicketDispatchSettings, { workspace, onSaved: (next) => { current = next; } }));
  t.after(() => { view.unmount(); dom.cleanup(); });
  const { container } = view;

  const save = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save');
  assert.equal(save.disabled, true, 'nothing changed yet');

  typeInto(inputByLabel(container, 'Auto-archive done tickets (days)'), '');
  typeInto(inputByLabel(container, 'Max concurrent tickets per agent'), '3');
  await flush();
  assert.equal(save.disabled, false);
  click(save);
  await flush();

  assert.deepEqual(calls, [{ id: 'ws-1', data: { max_concurrent_tickets_per_agent: 3, auto_archive_days: null } }]);
  assert.equal(current.max_concurrent_tickets_per_agent, 3);

  const pause = [...container.querySelectorAll('label')]
    .find((l) => l.textContent?.includes('Pause ticket dispatch'))
    .querySelector('input[type="checkbox"]');
  assert.equal(pause.checked, false);
  click(pause);
  await flush();
  assert.equal(calls.length, 2);
  assert.deepEqual(Object.keys(calls[1].data), ['dispatch_paused_at']);
  assert.match(calls[1].data.dispatch_paused_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('invalid input blocks the save and shows the error', async (t) => {
  const dom = setupDom();
  const calls = [];
  const original = api.updateWorkspace;
  api.updateWorkspace = async (id, data) => { calls.push({ id, data }); return null; };
  t.after(() => { api.updateWorkspace = original; });

  const workspace = { id: 'ws-1', name: 'W', description: '', created_at: '', updated_at: '', ...STORED };
  const view = mount(React.createElement(TicketDispatchSettings, { workspace, onSaved: () => {} }));
  t.after(() => { view.unmount(); dom.cleanup(); });
  const { container } = view;

  typeInto(inputByLabel(container, 'Auto-archive done tickets (days)'), '400');
  await flush();
  const save = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save');
  // An invalid form builds no patch → nothing to save, and the reason is shown.
  assert.equal(save.disabled, true);
  assert.match(container.textContent, /Enter 1–365 days, or leave blank to disable\./);
  assert.equal(calls.length, 0);
});
