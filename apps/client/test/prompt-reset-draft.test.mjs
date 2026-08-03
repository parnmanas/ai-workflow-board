import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resetTemplateDraft,
  resetAllTemplateDrafts,
  resetColumnMappingDraft,
  resetAllColumnMappingDrafts,
} from '../src/utils/promptResetDraft.ts';

const defaults = [
  { name: 'todo_workflow', description: 'Todo default', content: 'T', category: 'default_workflow', column_match: 'to do' },
  { name: 'review_workflow', description: 'Review default', content: 'R', category: 'default_workflow', column_match: 'review' },
];

test('single and all template resets stage built-ins without changing source templates', () => {
  const original = [
    { id: 't1', name: 'todo_workflow', description: 'Customized', content: 'custom', category: 'default_workflow' },
    { id: 'u1', name: 'my_template', description: 'User', content: 'keep', category: 'custom' },
  ];
  const one = resetTemplateDraft({}, defaults[0]);
  assert.deepEqual(Object.keys(one), ['todo_workflow']);
  assert.equal(one.todo_workflow.content, 'T');
  const all = resetAllTemplateDrafts(one, defaults);
  assert.deepEqual(Object.keys(all).sort(), ['review_workflow', 'todo_workflow']);
  assert.equal(original[0].content, 'custom');
  assert.equal(original[1].content, 'keep');
});

test('column reset selects the matching built-in and preserves unmatched mappings', () => {
  const templates = [
    { id: 't1', name: 'todo_workflow' },
    { id: 'r1', name: 'review_workflow' },
  ];
  const original = { c1: 'custom-a', c2: 'custom-b', c3: 'custom-c' };
  const one = resetColumnMappingDraft(original, { id: 'c1', name: 'To Do' }, defaults, templates);
  assert.deepEqual(one, { c1: 't1', c2: 'custom-b', c3: 'custom-c' });
  const unmatched = resetColumnMappingDraft(one, { id: 'c3', name: 'Customer Sign-off' }, defaults, templates);
  assert.deepEqual(unmatched, one);

  const all = resetAllColumnMappingDrafts(
    original,
    [{ id: 'c1', name: 'To Do' }, { id: 'c2', name: 'Review' }, { id: 'c3', name: 'Customer Sign-off' }],
    defaults,
    templates,
  );
  assert.deepEqual(all, { c1: 't1', c2: 'r1', c3: 'custom-c' });
  assert.deepEqual(original, { c1: 'custom-a', c2: 'custom-b', c3: 'custom-c' });
});
