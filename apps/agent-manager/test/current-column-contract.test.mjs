import { test } from 'node:test';
import assert from 'node:assert/strict';

import { composeTriggerPrompt } from '../dist/lib/prompts.js';

test('ticket trigger makes the current column the execution boundary', () => {
  const prompt = composeTriggerPrompt(
    {
      id: '11111111-1111-4111-8111-111111111111',
      title: 'Implement the requested change',
      status: 'todo',
      legacy_status: 'todo',
      current_column_name: 'Merging',
      current_column_kind: 'merging',
      current_column_id: 'column-1',
    },
    '',
    'Implement the ticket.',
    '',
    { name: 'in_progress_workflow', content: 'Implement and hand off to Review.' },
  );

  assert.match(prompt, /current column workflow guide is the complete scope for this turn/i);
  assert.match(prompt, /current_column_id, current_column_name, and current_column_kind are the canonical workflow state/i);
  assert.match(prompt, /never interpret legacy_status.*as the current column/i);
  assert.match(prompt, /Current column: Merging \(kind: merging, id: column-1\)/);
  assert.match(prompt, /do not perform work assigned to a later column/i);
  assert.match(prompt, /inspect the ticket, repository, and available AWB context before asking/i);
  assert.match(prompt, /ask only when the current-column work is blocked/i);
});
