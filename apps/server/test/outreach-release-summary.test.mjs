// Unit tests for TemplateReleaseSummarizer (ticket d86d0c24 step 4) — a
// deterministic, non-promotional release-note generator. Covers: ticket list
// rendering, the "no Done tickets" fallback line, the bot-disclosure footer
// being present verbatim, and the previous-commit line being omitted on a
// channel's first-ever publish (previousCommitSha='').

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TemplateReleaseSummarizer } from '../dist/modules/outreach/release-summary.js';

test('summarize lists Done ticket titles as a bullet list', async () => {
  const s = new TemplateReleaseSummarizer();
  const result = await s.summarize({
    environment: 'production',
    deployedCommitSha: 'abcdef1234567890',
    previousCommitSha: '1111111111111111',
    doneTickets: [{ id: 't1', title: 'Fix login bug' }, { id: 't2', title: 'Add dark mode' }],
  });
  assert.match(result.title, /production/);
  assert.match(result.title, /abcdef123456/); // title carries a 12-char short sha
  assert.match(result.body, /- Fix login bug/);
  assert.match(result.body, /- Add dark mode/);
  assert.match(result.body, /Environment: production/);
  assert.match(result.body, /Previous: 111111111111/);
});

test('summarize with no Done tickets uses the maintenance fallback line, not an empty list', async () => {
  const s = new TemplateReleaseSummarizer();
  const result = await s.summarize({
    environment: 'staging',
    deployedCommitSha: 'deadbeef0000',
    previousCommitSha: '',
    doneTickets: [],
  });
  assert.match(result.body, /maintenance\/infrastructure/);
  assert.doesNotMatch(result.body, /^- /m);
});

test('summarize omits the Previous line on a first-ever publish (no previousCommitSha)', async () => {
  const s = new TemplateReleaseSummarizer();
  const result = await s.summarize({
    environment: 'production',
    deployedCommitSha: 'abc123',
    previousCommitSha: '',
    doneTickets: [],
  });
  assert.doesNotMatch(result.body, /Previous:/);
});

test('summarize always includes the bot-disclosure footer verbatim', async () => {
  const s = new TemplateReleaseSummarizer();
  const result = await s.summarize({
    environment: 'production', deployedCommitSha: 'sha1', previousCommitSha: '', doneTickets: [],
  });
  assert.match(result.body, /This update was posted automatically by an AWB outreach bot\./);
});

test('summarize never emits promotional/marketing language', async () => {
  const s = new TemplateReleaseSummarizer();
  const result = await s.summarize({
    environment: 'production',
    deployedCommitSha: 'sha1',
    previousCommitSha: '',
    doneTickets: [{ id: 't1', title: 'Improve query performance' }],
  });
  const lower = result.body.toLowerCase();
  for (const promo of ['amazing', 'exciting', 'check it out', "don't miss", 'buy now']) {
    assert.doesNotMatch(lower, new RegExp(promo));
  }
});
