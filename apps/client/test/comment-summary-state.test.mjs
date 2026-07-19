import test from 'node:test';
import assert from 'node:assert/strict';

import { isCommentSummaryInProgress } from '../src/utils/commentSummary.ts';

test('comment summary remains in progress during pending -> completing transition', () => {
  assert.equal(isCommentSummaryInProgress('pending'), true);
  assert.equal(isCommentSummaryInProgress('completing'), true);
  assert.equal(isCommentSummaryInProgress('completed'), false);
  assert.equal(isCommentSummaryInProgress('failed'), false);
  assert.equal(isCommentSummaryInProgress('idle'), false);
});
