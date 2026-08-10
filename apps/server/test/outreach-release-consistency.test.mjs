// Unit tests for the pure release-consistency analysis (ticket 31e7cd24
// 범위 3) — no DB, no HTTP; analyzeReleaseConsistency is a plain function.

import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeReleaseConsistency } from '../dist/modules/outreach/release-consistency.js';

test('flags undocumented changes when code files changed but README/CHANGELOG did not', () => {
  const report = analyzeReleaseConsistency({
    changedFiles: ['apps/server/src/foo.ts', 'apps/server/src/bar.ts'],
    openIssues: [],
    doneTickets: [],
  });
  assert.equal(report.undocumentedChanges, true);
  assert.match(report.summary, /문서 미갱신 후보/);
});

test('does NOT flag undocumented changes when README was touched', () => {
  const report = analyzeReleaseConsistency({
    changedFiles: ['apps/server/src/foo.ts', 'README.md'],
    openIssues: [],
    doneTickets: [],
  });
  assert.equal(report.undocumentedChanges, false);
});

test('does NOT flag undocumented changes when only test files changed', () => {
  const report = analyzeReleaseConsistency({
    changedFiles: ['apps/server/test/foo.test.mjs'],
    openIssues: [],
    doneTickets: [],
  });
  assert.equal(report.undocumentedChanges, false);
});

test('flags a CHANGELOG gap when Done tickets shipped but CHANGELOG was not touched', () => {
  const report = analyzeReleaseConsistency({
    changedFiles: ['apps/server/src/foo.ts'],
    openIssues: [],
    doneTickets: [{ id: 't1', title: 'Fix crash on save' }],
  });
  assert.equal(report.changelogGap, true);
  assert.match(report.summary, /CHANGELOG 누락 후보/);
});

test('does NOT flag a CHANGELOG gap when CHANGELOG.md was touched', () => {
  const report = analyzeReleaseConsistency({
    changedFiles: ['apps/server/src/foo.ts', 'CHANGELOG.md'],
    openIssues: [],
    doneTickets: [{ id: 't1', title: 'Fix crash on save' }],
  });
  assert.equal(report.changelogGap, false);
});

test('surfaces an open issue as a resolved candidate when its text shares a keyword with a changed file / Done ticket title', () => {
  const report = analyzeReleaseConsistency({
    changedFiles: ['apps/server/src/save-handler.ts'],
    openIssues: [{ number: 5, title: 'Crash when saving a document', body: 'App crashes on save', html_url: 'https://github.com/x/y/issues/5' }],
    doneTickets: [],
  });
  assert.equal(report.candidateResolvedIssues.length, 1);
  assert.equal(report.candidateResolvedIssues[0].number, 5);
  assert.match(report.summary, /#5/);
});

test('does not surface an unrelated open issue', () => {
  const report = analyzeReleaseConsistency({
    changedFiles: ['apps/server/src/save-handler.ts'],
    openIssues: [{ number: 6, title: 'Feature request: dark mode', body: 'Please add a theme toggle', html_url: 'https://github.com/x/y/issues/6' }],
    doneTickets: [],
  });
  assert.equal(report.candidateResolvedIssues.length, 0);
});

test('caps candidate issues at 10 even with more matches', () => {
  const openIssues = Array.from({ length: 15 }, (_, i) => ({
    number: i + 1, title: `save bug ${i + 1}`, body: 'save', html_url: `https://github.com/x/y/issues/${i + 1}`,
  }));
  const report = analyzeReleaseConsistency({
    changedFiles: ['apps/server/src/save-handler.ts'],
    openIssues,
    doneTickets: [],
  });
  assert.equal(report.candidateResolvedIssues.length, 10);
});

test('no code changes, no Done tickets, no matching issues → clean summary with no candidates/flags', () => {
  const report = analyzeReleaseConsistency({
    changedFiles: ['README.md'],
    openIssues: [{ number: 1, title: 'Totally unrelated', body: 'nothing to do with this release', html_url: 'https://github.com/x/y/issues/1' }],
    doneTickets: [],
  });
  assert.equal(report.undocumentedChanges, false);
  assert.equal(report.changelogGap, false);
  assert.equal(report.candidateResolvedIssues.length, 0);
  assert.match(report.summary, /특이사항 없음/);
});
