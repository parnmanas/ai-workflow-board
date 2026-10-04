// QA / Security on_failure_ticket ⇄ editor form (docs/tickets.md → QA / Security
// failure tickets). Boards are gone: the auto-filed fix ticket lands in the
// workspace pool with a status, tags and an optional project.
//
// Pins:
//   1. Stored rows written before the board removal still open correctly —
//      legacy `labels` read as tags, board/column/assignee_id ignored.
//   2. Saving never writes a retired key (board_id, column_id, column_name,
//      assignee_id, labels), even when the stored row carried them.
//   3. Keys the editor does not show (title_template, scenario-specific knobs)
//      survive a save.
//   4. Cleared project / tags / runtime are removed, not sent blank.
//   5. The project select keeps an unknown stored id visible.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RETIRED_ON_FAILURE_TICKET_KEYS,
  onFailureTicketFromForm,
  onFailureTicketToForm,
  normalizeTags,
  projectSelectOptions,
  readOnFailureTicketTags,
} from '../src/components/admin/onFailureTicket.logic.ts';

const LEGACY_ROW = {
  enabled: true,
  board_id: 'board-1',
  column_id: 'col-1',
  column_name: 'To Do',
  assignee_id: 'agent-1',
  labels: ['qa-failure', ' login '],
  priority: 'critical',
  dedupe: 'per_open_ticket',
  title_template: 'QA failed: {{scenario.name}}',
  rerun_on_fix: true,
  max_rerun_attempts: 2,
};

test('legacy row: labels read as tags, board keys ignored, defaults filled', () => {
  const form = onFailureTicketToForm(LEGACY_ROW);
  assert.deepEqual(form, {
    enabled: true,
    projectId: '',
    status: 'todo',
    priority: 'critical',
    dedupe: 'per_open_ticket',
    tags: ['qa-failure', 'login'],
    assigneeRuntime: null,
  });
});

test('tags win over legacy labels when both are present (even an empty tags list)', () => {
  assert.deepEqual(readOnFailureTicketTags({ tags: ['a'], labels: ['b'] }), ['a']);
  assert.deepEqual(readOnFailureTicketTags({ tags: [], labels: ['b'] }), []);
  assert.deepEqual(readOnFailureTicketTags({ labels: ['b'] }), ['b']);
  assert.deepEqual(readOnFailureTicketTags(null), []);
});

test('null / disabled config opens as a disabled form with defaults', () => {
  const form = onFailureTicketToForm(null);
  assert.equal(form.enabled, false);
  assert.equal(form.status, 'todo');
  assert.equal(form.priority, 'high');
  assert.equal(form.dedupe, 'per_run');
  assert.equal(form.projectId, '');
  assert.deepEqual(form.tags, []);
});

test('unknown status / priority values fall back to defaults instead of round-tripping garbage', () => {
  const form = onFailureTicketToForm({ enabled: true, status: 'in_progress', priority: 'urgent-ish' });
  assert.equal(form.status, 'todo');
  assert.equal(form.priority, 'high');
  assert.equal(onFailureTicketToForm({ enabled: true, status: 'backlog' }).status, 'backlog');
});

test('saving a legacy row strips every retired key and writes tags instead of labels', () => {
  const form = onFailureTicketToForm(LEGACY_ROW);
  const payload = onFailureTicketFromForm({ ...form, projectId: 'proj-1', status: 'backlog' }, LEGACY_ROW);
  for (const key of RETIRED_ON_FAILURE_TICKET_KEYS) {
    assert.equal(key in payload, false, `${key} must not be written back`);
  }
  assert.deepEqual(payload, {
    enabled: true,
    project_id: 'proj-1',
    status: 'backlog',
    priority: 'critical',
    dedupe: 'per_open_ticket',
    tags: ['qa-failure', 'login'],
    // carried over — the editor does not own these
    title_template: 'QA failed: {{scenario.name}}',
    rerun_on_fix: true,
    max_rerun_attempts: 2,
  });
});

test('disabled form sends an explicit { enabled: false } so a stored policy turns off', () => {
  const form = { ...onFailureTicketToForm(LEGACY_ROW), enabled: false };
  assert.deepEqual(onFailureTicketFromForm(form, LEGACY_ROW), { enabled: false });
});

test('cleared project / tags / runtime are removed, not sent blank', () => {
  const stored = {
    enabled: true, project_id: 'proj-1', tags: ['x'], status: 'todo',
    assignee_runtime: { manager_agent_id: 'host-1', cli: 'claude', working_dir: '/w' },
  };
  const form = { ...onFailureTicketToForm(stored), projectId: '  ', tags: [' ', ''], assigneeRuntime: null };
  const payload = onFailureTicketFromForm(form, stored);
  assert.equal('project_id' in payload, false);
  assert.equal('tags' in payload, false);
  assert.equal('assignee_runtime' in payload, false);
  assert.equal(payload.status, 'todo');
});

test('assignee runtime round-trips', () => {
  const runtime = { manager_agent_id: 'host-1', cli: 'claude', working_dir: '/w' };
  const form = onFailureTicketToForm({ enabled: true, assignee_runtime: runtime });
  assert.deepEqual(form.assigneeRuntime, runtime);
  assert.deepEqual(onFailureTicketFromForm(form).assignee_runtime, runtime);
});

test('stored tags are sanitized: trimmed, non-strings dropped, case-insensitive de-dupe keeps first spelling', () => {
  assert.deepEqual(normalizeTags([' Bug', 'ui', 'bug ', '', null, 3, 'login   flow']), ['Bug', 'ui', 'login flow']);
  assert.deepEqual(readOnFailureTicketTags({ labels: ['x', 'X', ' y '] }), ['x', 'y']);
});

test('project select keeps an unknown stored id visible instead of snapping to none', () => {
  const projects = [{ id: 'p1', name: 'AWB' }, { id: 'p2', name: '' }];
  assert.deepEqual(projectSelectOptions(projects, '', '(none)'), [
    { value: '', label: '(none)' },
    { value: 'p1', label: 'AWB' },
    { value: 'p2', label: 'p2' },
  ]);
  const withUnknown = projectSelectOptions(projects, 'deleted-project-id', '(none)');
  assert.equal(withUnknown.length, 4);
  assert.equal(withUnknown[3].value, 'deleted-project-id');
  assert.match(withUnknown[3].label, /알 수 없는 프로젝트/);
});
