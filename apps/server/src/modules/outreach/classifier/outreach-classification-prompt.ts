import { InboundItem } from '../connectors/types';
import { ClassificationContext } from './types';

/**
 * Render the instruction prompt sent to the agent dispatched to classify one
 * outreach inbound item. Kept as a pure function (mirrors
 * security-prompt.ts's renderSecurityRunPrompt) so the dispatch call site is
 * the only thing that needs testing against real DB rows.
 */
export function renderOutreachClassificationPrompt(
  context: ClassificationContext,
  item: InboundItem,
  runId: string,
): string {
  return [
    `An inbound item from an outreach channel (\`${context.channelKind}\`) needs classification.`,
    '',
    `**Title:** ${item.title || '(no title)'}`,
    `**Author:** ${item.author || '(unknown)'}`,
    `**Source:** ${item.permalink || '(no link)'}`,
    '',
    '**Body:**',
    item.body || '(empty)',
    '',
    'Classify this item into exactly one category:',
    '  - `bug` — reports something broken, erroring, or regressed.',
    '  - `feature_request` — asks for new or enhanced functionality.',
    '  - `question` — asks how to do something or for clarification; not a bug report.',
    '  - `noise` — spam, off-topic, or otherwise not actionable feedback.',
    '',
    'Also give a confidence score from 0 to 100 for your classification (100 = certain).',
    '',
    `Report back by calling \`record_outreach_classification\` exactly once with run_id="${runId}", ` +
      'your chosen category, and your confidence score. Do not create a ticket or reply to the ' +
      'source yourself — this room only collects your classification.',
  ].join('\n');
}
