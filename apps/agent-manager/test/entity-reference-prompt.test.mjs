import assert from 'node:assert/strict';
import test from 'node:test';
import {
  composeCommentMentionPrompt,
  composeTriggerPrompt,
} from '../dist/lib/prompts.js';

const ticket = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Named ticket',
  description: 'Regression fixture',
  comments: [],
};

test('trigger prompt renders the authoritative current column snapshot', () => {
  const prompt = composeTriggerPrompt({
    ...ticket,
    current_column_id: 'column-review',
    current_column_name: 'Review',
    current_column_kind: 'review',
  }, '', '', ticket.id, null);
  assert.match(prompt, /Current column: Review \(kind: review, id: column-review\)/);
});

for (const [name, output] of [
  ['trigger', composeTriggerPrompt(ticket, '', '', ticket.id, null)],
  ['comment', composeCommentMentionPrompt(ticket, '', { content: 'Please check this.' }, ticket.id)],
]) {
  test(`${name} prompt names the ticket with a clickable artifact reference`, () => {
    assert.match(output, new RegExp(`#\\[ticket:${ticket.id}\\|Named ticket\\]`));
    assert.doesNotMatch(output, /Ticket ID:\s*[0-9a-f]{8}(?:\\s|$)/i);
    assert.match(output, /Never use only a shortened id/);
  });
}
