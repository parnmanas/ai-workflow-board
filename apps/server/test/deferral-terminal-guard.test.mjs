// Unit test — deferral-to-terminal guard (ticket 9f2adfd0).
//
// A review/merge/handoff comment that hands scope to an ALREADY-TERMINAL ticket
// (Done/archived) silently loses that scope — a terminal ticket is never picked
// up again. INV-5 (d5b53a1b) deferred its restart-persist demonstration to the
// already-Done INV-2 (8294bc2b) twice, orphaning shipped persistence work.
//
// The guard is NON-BLOCKING (flags, never rejects) so it lives as pure logic
// with an injected resolver — exercised here without a DataSource, plus a
// static grep that `add_comment` stays wired to it (mirrors
// terminal-reopen-guard.test.mjs). Imports the compiled module from dist/
// (built by `npm run build`).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist', 'modules', 'mcp', 'shared', 'deferral-terminal-guard.js');

const {
  hasDeferralIntent,
  extractTicketIdCandidates,
  referencedUnderDeferral,
  detectDeferralToTerminal,
  formatDeferralTerminalWarning,
} = await import('file://' + DIST);

const DONE = 'aaaaaaaa-1111-2222-3333-444444444444';
const OPEN = 'bbbbbbbb-1111-2222-3333-555555555555';
const ARCHIVED = 'cccccccc-1111-2222-3333-666666666666';

// Resolver stub modelling the DB-backed lookup in comment-tools.ts. Resolves
// full UUIDs exactly and 8-hex tokens by prefix; returns null for anything else
// (a git SHA that isn't a ticket id).
const TICKETS = {
  [DONE]: { id: DONE, title: 'INV-2', columnName: 'Done', isTerminal: true, archived: false },
  [OPEN]: { id: OPEN, title: 'INV-6', columnName: 'Backlog', isTerminal: false, archived: false },
  [ARCHIVED]: { id: ARCHIVED, title: 'Old', columnName: 'Done', isTerminal: true, archived: true },
};
function makeResolver({ throwOn = null } = {}) {
  const calls = [];
  const resolve = (token) => {
    calls.push(token);
    if (throwOn && token === throwOn) throw new Error('boom');
    if (TICKETS[token]) return TICKETS[token];
    const hit = Object.values(TICKETS).find((t) => t.id.startsWith(token));
    return hit || null;
  };
  resolve.calls = calls;
  return resolve;
}

// ─── hasDeferralIntent ───────────────────────────────────────────────
test('hasDeferralIntent: English phrases', () => {
  assert.equal(hasDeferralIntent('tracked in the other ticket'), true);
  assert.equal(hasDeferralIntent('this is deferred to next sprint'), true);
  assert.equal(hasDeferralIntent('rolled into the epic'), true);
});
test('hasDeferralIntent: Korean phrases', () => {
  assert.equal(hasDeferralIntent('EPIC 트랙과 함께 이관합니다'), true);
  assert.equal(hasDeferralIntent('후속 티켓에서 트래킹'), true);
});
test('hasDeferralIntent: plain comment with no deferral phrasing', () => {
  assert.equal(hasDeferralIntent('LGTM, compile gate green, merging.'), false);
  assert.equal(hasDeferralIntent(''), false);
});

// ─── extractTicketIdCandidates ───────────────────────────────────────
test('extract: full UUID + bare 8-hex short id, deduped + lower-cased', () => {
  const got = extractTicketIdCandidates(`see \`${DONE}\` and short \`8294BC2B\``);
  assert.ok(got.includes(DONE));
  assert.ok(got.includes('8294bc2b'));
});
test('extract: does NOT re-emit a UUID leading group as a separate short id', () => {
  const got = extractTicketIdCandidates(DONE);
  assert.deepEqual(got, [DONE], 'only the full UUID, not its 8-hex head');
});
test('extract: ignores 9+ char git SHAs (not 8-hex short-id shaped)', () => {
  // `a1577bbbd` (9 hex) is a SHA the board writes in backticks — must not be
  // treated as a ticket id.
  assert.deepEqual(extractTicketIdCandidates('merged `a1577bbbd`'), []);
});
test('extract: nothing when no ids present', () => {
  assert.deepEqual(extractTicketIdCandidates('just prose, no ids'), []);
});

// ─── referencedUnderDeferral (proximity) ─────────────────────────────
test('proximity: keyword near the token → true', () => {
  assert.equal(referencedUnderDeferral('this is tracked in `8294bc2b` now', '8294bc2b'), true);
});
test('proximity: token far from any keyword → false', () => {
  const far = '이관합니다.' + ' '.repeat(200) + '관련 없는 참고: 8294bc2b';
  assert.equal(referencedUnderDeferral(far, '8294bc2b'), false);
});

// ─── detectDeferralToTerminal ────────────────────────────────────────
test('detect: deferral phrasing + terminal target → flagged', async () => {
  const resolver = makeResolver();
  const out = await detectDeferralToTerminal(`이 실증은 INV-2 \`${DONE}\` 와 함께 이관합니다.`, resolver);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, DONE);
});
test('detect: deferral phrasing + NON-terminal target → not flagged', async () => {
  const resolver = makeResolver();
  const out = await detectDeferralToTerminal(`tracked in \`${OPEN}\``, resolver);
  assert.deepEqual(out, []);
});
test('detect: no deferral phrasing (early-out) → not flagged even if Done id present', async () => {
  const resolver = makeResolver();
  const out = await detectDeferralToTerminal(`관련 참고 자료: \`${DONE}\``, resolver);
  assert.deepEqual(out, [], 'a bare Done-ticket mention without deferral intent must not warn');
  assert.equal(resolver.calls.length, 0, 'early-out must skip the resolver entirely');
});
test('detect: archived target flagged even if column not terminal', async () => {
  const resolver = makeResolver();
  const out = await detectDeferralToTerminal(`이관 → \`${ARCHIVED}\``, resolver);
  assert.equal(out.length, 1);
  assert.equal(out[0].archived, true);
});
test('detect: self-reference excluded', async () => {
  const resolver = makeResolver();
  const out = await detectDeferralToTerminal(`이 작업은 이관 없이 \`${DONE}\` 에서 계속`, resolver, { selfTicketId: DONE });
  assert.deepEqual(out, []);
});
test('detect: unresolved token (git SHA) dropped, real terminal target still flagged', async () => {
  const resolver = makeResolver();
  const out = await detectDeferralToTerminal(
    `deferred: build \`deadbeef\` — tracked in \`${DONE}\``,
    resolver,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].id, DONE);
});
test('detect: a resolver throw on one token does not crash; others still evaluated', async () => {
  const resolver = makeResolver({ throwOn: 'deadbeef' });
  const out = await detectDeferralToTerminal(
    `이관: \`deadbeef\` 그리고 \`${DONE}\``,
    resolver,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].id, DONE);
});
test('detect: dedupes the same terminal target referenced twice', async () => {
  const resolver = makeResolver();
  const out = await detectDeferralToTerminal(
    `이관 \`${DONE}\` ... 다시 tracked in \`${DONE}\``,
    resolver,
  );
  assert.equal(out.length, 1);
});

// ─── formatDeferralTerminalWarning ───────────────────────────────────
test('format: names each target + the advisory', () => {
  const msg = formatDeferralTerminalWarning([TICKETS[DONE]]);
  assert.match(msg, /Deferral-to-terminal warning/);
  assert.match(msg, new RegExp(DONE));
  assert.match(msg, /never picked up again/);
  assert.match(msg, /Open a NEW live ticket/);
});
test('format: empty for no targets', () => {
  assert.equal(formatDeferralTerminalWarning([]), '');
});

// ─── static grep: add_comment stays wired to the guard ───────────────
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}
test('comment-tools.ts wires detectDeferralToTerminal into add_comment', () => {
  const src = stripComments(
    fs.readFileSync(path.resolve(__dirname, '..', 'src', 'modules/mcp/tools/comment-tools.ts'), 'utf8'),
  );
  assert.match(src, /import\s*\{[^}]*detectDeferralToTerminal[^}]*\}\s*from\s*'\.\.\/shared\/deferral-terminal-guard'/);
  assert.match(src, /detectDeferralToTerminal\(/, 'add_comment must invoke the guard');
  assert.match(src, /deferral_terminal_warning/, 'the flag must be persisted onto comment metadata');
});
