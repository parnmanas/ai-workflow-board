// TicketPanel Save/Discard draft — pure logic (board-less tickets, docs/tickets.md).
//
// The panel buffers detail-tab edits and commits computeDirtyTicketFields() as
// ONE `PATCH /tickets/:id`. These tests pin the PATCH body shape (keys are the
// TicketPatch contract), the "untouched tags/assignee never look dirty after a
// server-normalized save" rule, and the assignee display fallbacks.
//
// 실행:  node --import tsx --test apps/client/test/ticket-panel-draft.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import { assigneeLeafName } from '../src/tickets/assignee.ts';
import {
  collectTagPool,
  computeDirtyTicketFields,
  draftFromTicket,
  effectiveAssignee,
  effectiveTags,
  openPrerequisiteCount,
  runtimeSpecEqual,
  settleSavedDraft,
  tagsEqual,
  toEditableSpec,
} from '../src/components/ticketPanel/ticketDraft.ts';

const spec = (over = {}) => ({
  manager_agent_id: 'host-1',
  cli: 'claude',
  model: null,
  working_dir: '/srv/work/awb',
  folder_scope: 'shared',
  credential_id: null,
  cli_runtime_profile: null,
  runtime_config: { strategy: 'single', permission_mode: 'approve' },
  label: '',
  role_prompt: '',
  ...over,
});

const baseTicket = (over = {}) => ({
  title: 'Fix login',
  description: 'desc',
  priority: 'medium',
  tags: ['bug', 'auth'],
  project_id: 'p1',
  base_branch: '',
  assignee: spec(),
  channel_ids: ['c1', 'c2'],
  next_ticket_id: null,
  on_done_action_ids: [],
  ...over,
});

test('a fresh draft is clean', () => {
  const t = baseTicket();
  assert.deepEqual(computeDirtyTicketFields(draftFromTicket(t), t), {});
});

test('dirty fields use the PATCH /tickets/:id keys', () => {
  const t = baseTicket();
  const d = {
    ...draftFromTicket(t),
    title: 'Fix login redirect',
    priority: 'high',
    tags: ['bug', 'auth', 'ui'],
    projectId: '',
    baseBranch: 'release',
    assignee: { value: null },
    channelIds: ['c1'],
    nextTicketId: 'n1',
  };
  assert.deepEqual(computeDirtyTicketFields(d, t), {
    title: 'Fix login redirect',
    priority: 'high',
    tags: ['bug', 'auth', 'ui'],
    project_id: null,
    base_branch: 'release',
    assignee: null,
    channel_ids: ['c1'],
    next_ticket_id: 'n1',
  });
});

test('tag order and channel order do not make the draft dirty; tag case does', () => {
  const t = baseTicket();
  assert.deepEqual(computeDirtyTicketFields({ ...draftFromTicket(t), tags: ['auth', 'bug'] }, t), {});
  assert.deepEqual(computeDirtyTicketFields({ ...draftFromTicket(t), channelIds: ['c2', 'c1'] }, t), {});
  assert.deepEqual(computeDirtyTicketFields({ ...draftFromTicket(t), tags: ['Bug', 'auth'] }, t), { tags: ['Bug', 'auth'] });
  assert.equal(tagsEqual(null, []), true);
});

test('clearing next ticket sends null; clearing base branch sends ""', () => {
  const t = baseTicket({ next_ticket_id: 'n1', base_branch: 'dev' });
  const d = { ...draftFromTicket(t), nextTicketId: '', baseBranch: '' };
  assert.deepEqual(computeDirtyTicketFields(d, t), { next_ticket_id: null, base_branch: '' });
});

test('assignee compares by value, independent of key order', () => {
  const t = baseTicket();
  const reordered = Object.fromEntries(Object.entries(spec()).reverse());
  assert.equal(runtimeSpecEqual(reordered, t.assignee), true);
  const same = { ...draftFromTicket(t), assignee: { value: reordered } };
  assert.deepEqual(computeDirtyTicketFields(same, t), {});
  const other = { ...draftFromTicket(t), assignee: { value: spec({ model: 'opus' }) } };
  assert.deepEqual(Object.keys(computeDirtyTicketFields(other, t)), ['assignee']);
  assert.equal(runtimeSpecEqual(null, undefined), true);
  assert.equal(runtimeSpecEqual(null, spec()), false);
});

test('untouched tags/assignee follow the server value', () => {
  const t = baseTicket();
  const d = draftFromTicket(t);
  assert.deepEqual(effectiveTags(d, t), ['bug', 'auth']);
  assert.equal(effectiveAssignee(d, t), t.assignee);
  const cleared = { ...d, assignee: { value: null } };
  assert.equal(effectiveAssignee(cleared, t), null);
});

test('settleSavedDraft drops saved overrides so a normalized server value is not a phantom edit', () => {
  const t = baseTicket();
  const saved = { ...draftFromTicket(t), tags: ['bug', 'auth', ' ui '], assignee: { value: spec({ model: 'opus' }) } };
  // Server trims the tag and adds a runtime_config key on save.
  const after = baseTicket({ tags: ['bug', 'auth', 'ui'], assignee: spec({ model: 'opus', runtime_config: { strategy: 'single', permission_mode: 'approve', extra: {} } }) });
  assert.notDeepEqual(computeDirtyTicketFields(saved, after), {}, 'precondition: without settling the draft looks dirty');
  const settled = settleSavedDraft(saved, saved);
  assert.equal(settled.tags, null);
  assert.equal(settled.assignee, null);
  assert.deepEqual(computeDirtyTicketFields(settled, after), {});
});

test('settleSavedDraft keeps edits made while the save was in flight', () => {
  const t = baseTicket();
  const saved = { ...draftFromTicket(t), tags: ['bug'] };
  const newer = { ...saved, tags: ['bug', 'later'] };
  assert.deepEqual(settleSavedDraft(newer, saved).tags, ['bug', 'later']);
  const untouched = draftFromTicket(t);
  assert.equal(settleSavedDraft(untouched, untouched), untouched, 'nothing to settle → same object');
});

test('collectTagPool counts tags across roots and children, case-insensitively', () => {
  const pool = collectTagPool([
    { tags: ['bug', 'ui'], children: [{ tags: ['Bug'] }] },
    { tags: ['ops', ' ui '], children: [] },
    { tags: [] },
  ]);
  assert.deepEqual(pool, [
    { tag: 'bug', count: 2 },
    { tag: 'ui', count: 2 },
    { tag: 'ops', count: 1 },
  ]);
  assert.deepEqual(collectTagPool(undefined), []);
});

test('assignee display leaf (shared tickets/assignee.ts): label → folder/cli (server default label) → cli (never a host id)', () => {
  assert.equal(assigneeLeafName(spec({ label: 'Reviewer' })), 'Reviewer');
  assert.equal(assigneeLeafName(spec()), 'awb/claude');
  assert.equal(assigneeLeafName(spec({ working_dir: '' })), 'claude');
  assert.equal(assigneeLeafName(null), '');
  assert.ok(!assigneeLeafName(spec()).includes('host-1'));
});

test('toEditableSpec fills missing keys for the editor without dropping runtime_config', () => {
  const s = toEditableSpec({ manager_agent_id: 'h', cli: 'codex', working_dir: '/w', runtime_config: { extra: { effort: 'high' } } });
  assert.equal(s.folder_scope, 'shared');
  assert.equal(s.label, '');
  assert.deepEqual(s.runtime_config, { strategy: 'single', permission_mode: 'approve', extra: { effort: 'high' } });
  assert.equal(toEditableSpec(null).manager_agent_id, '');
});

test('openPrerequisiteCount ignores done, archived and missing prerequisites', () => {
  const row = (prerequisite) => ({ ticket_id: 't', prerequisite_ticket_id: 'p', created_at: '', created_by: '', reason: '', prerequisite });
  assert.equal(openPrerequisiteCount([
    row({ id: '1', title: 'a', status: 'todo', is_done: false, archived_at: null }),
    row({ id: '2', title: 'b', status: 'done', is_done: true, archived_at: null }),
    row({ id: '3', title: 'c', status: 'review', is_done: false, archived_at: '2026-01-01' }),
    row(null),
  ]), 1);
});
