// Behavioral tests for GitHubConnector (ticket 31e7cd24) — drives
// fetchInbound (new issues, threaded comments, self-loop exclusion, PR
// filtering, whitelist fail-closed), publish/reply/close, and the reactive
// 429 / 403-with-Retry-After rate-limit retry entirely against a fake
// `fetch` (github-connector.service.ts's `githubApiCall` fetchImpl seam) —
// no real network call. Mirrors outreach-reddit-connector.test.mjs's shape.

import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubConnector, GitHubConnectorConfigError } from '../dist/modules/outreach/connectors/github.connector.js';
import { GitHubApiError, GitHubForbiddenError } from '../dist/services/github-connector.service.js';
import { OutreachRateLimiter, OutreachChannelRateLimitedError } from '../dist/modules/outreach/outreach-rate-limiter.js';

function fakeResponse({ status = 200, json, text, headers = {} } = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => h.get(name.toLowerCase()) ?? null },
    async json() { return json !== undefined ? json : JSON.parse(text || '{}'); },
    async text() { return text !== undefined ? text : JSON.stringify(json ?? {}); },
  };
}

function makeCred(token = 'ghp_test123') {
  return { token, extra: {} };
}

function noopSleep() { return Promise.resolve(); }

test('constructor throws GitHubConnectorConfigError when token is missing', () => {
  assert.throws(() => new GitHubConnector({ token: '', extra: {} }, { targets: ['x/y'] }), GitHubConnectorConfigError);
});

test('fetchInbound: empty targets makes ZERO network calls (fail-closed, no auto-discovery)', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(String(url)); return fakeResponse({ json: { login: 'awb-bot' } }); };
  const conn = new GitHubConnector(makeCred(), { targets: [], fetchImpl, sleepImpl: noopSleep });
  const items = await conn.fetchInbound('');
  assert.deepEqual(items, []);
  assert.equal(calls.length, 0);
});

test('fetchInbound: a new open issue becomes an InboundItem; pull requests are filtered out', async () => {
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.endsWith('/user')) return fakeResponse({ json: { login: 'awb-bot' } });
    if (u.includes('/repos/x/y/issues?')) {
      return fakeResponse({
        json: [
          { number: 1, title: 'Crash on save', body: 'steps...', html_url: 'https://github.com/x/y/issues/1', user: { login: 'reporter1' }, state: 'open', created_at: '2026-06-25T10:00:00Z', updated_at: '2026-06-25T10:00:00Z' },
          { number: 2, title: 'a PR', body: '', html_url: 'https://github.com/x/y/pull/2', user: { login: 'someone' }, state: 'open', created_at: '2026-06-25T10:05:00Z', updated_at: '2026-06-25T10:05:00Z', pull_request: {} },
        ],
      });
    }
    if (u.includes('/issues/1/comments')) return fakeResponse({ json: [] });
    if (u.includes('/issues/2/comments')) return fakeResponse({ json: [] });
    throw new Error(`unexpected url ${u}`);
  };
  const conn = new GitHubConnector(makeCred(), { targets: ['x/y'], fetchImpl, sleepImpl: noopSleep });
  const items = await conn.fetchInbound('');
  assert.equal(items.length, 1, 'the PR was filtered out');
  assert.equal(items[0].external_item_id, 'issue:x/y#1');
  assert.equal(items[0].title, 'Crash on save');
  assert.equal(items[0].author, 'reporter1');
  assert.equal(items[0].parent_external_item_id, undefined);
});

test('fetchInbound: a new comment on an issue is tagged with parent_external_item_id', async () => {
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.endsWith('/user')) return fakeResponse({ json: { login: 'awb-bot' } });
    if (u.includes('/repos/x/y/issues?')) {
      return fakeResponse({
        json: [{ number: 1, title: 'Crash', body: '', html_url: 'https://github.com/x/y/issues/1', user: { login: 'reporter1' }, state: 'open', created_at: '2026-06-20T00:00:00Z', updated_at: '2026-06-25T10:30:00Z' }],
      });
    }
    if (u.includes('/issues/1/comments')) {
      return fakeResponse({
        json: [{ id: 555, body: 'more details', html_url: 'https://github.com/x/y/issues/1#issuecomment-555', user: { login: 'commenter1' }, created_at: '2026-06-25T10:30:00Z', updated_at: '2026-06-25T10:30:00Z' }],
      });
    }
    throw new Error(`unexpected url ${u}`);
  };
  const conn = new GitHubConnector(makeCred(), { targets: ['x/y'], fetchImpl, sleepImpl: noopSleep });
  // The issue itself was created 06-20 (before the cursor) — only its NEW
  // comment (06-25 10:30, after the cursor) should survive the since-filter.
  const items = await conn.fetchInbound(new Date('2026-06-25T09:00:00Z').toISOString());
  assert.equal(items.length, 1);
  assert.equal(items[0].external_item_id, 'comment:x/y#1:555');
  assert.equal(items[0].parent_external_item_id, 'issue:x/y#1');
  assert.equal(items[0].author, 'commenter1');
});

test("fetchInbound: the bot's own issues and comments are excluded (self-referential loop prevention)", async () => {
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.endsWith('/user')) return fakeResponse({ json: { login: 'awb-bot' } });
    if (u.includes('/repos/x/y/issues?')) {
      return fakeResponse({
        json: [
          { number: 1, title: 'Bot-filed issue', body: '', html_url: 'https://github.com/x/y/issues/1', user: { login: 'awb-bot' }, state: 'open', created_at: '2026-06-25T10:00:00Z', updated_at: '2026-06-25T10:00:00Z' },
          { number: 2, title: 'Human issue', body: '', html_url: 'https://github.com/x/y/issues/2', user: { login: 'human1' }, state: 'open', created_at: '2026-06-25T10:00:00Z', updated_at: '2026-06-25T10:00:00Z' },
        ],
      });
    }
    if (u.includes('/issues/1/comments')) return fakeResponse({ json: [] });
    if (u.includes('/issues/2/comments')) {
      return fakeResponse({
        json: [
          { id: 1, body: 'bot reply', html_url: 'https://github.com/x/y/issues/2#issuecomment-1', user: { login: 'AWB-Bot' }, created_at: '2026-06-25T10:30:00Z', updated_at: '2026-06-25T10:30:00Z' },
          { id: 2, body: 'human reply', html_url: 'https://github.com/x/y/issues/2#issuecomment-2', user: { login: 'human2' }, created_at: '2026-06-25T10:31:00Z', updated_at: '2026-06-25T10:31:00Z' },
        ],
      });
    }
    throw new Error(`unexpected url ${u}`);
  };
  const conn = new GitHubConnector(makeCred(), { targets: ['x/y'], fetchImpl, sleepImpl: noopSleep });
  const items = await conn.fetchInbound('');
  const ids = items.map((i) => i.external_item_id).sort();
  // Bot-filed issue #1 excluded entirely; on #2 only the human's comment
  // survives ("AWB-Bot" matched case-insensitively against "awb-bot").
  assert.deepEqual(ids, ['comment:x/y#2:2', 'issue:x/y#2']);
});

test('publish opens a new issue — the closest GitHub analog to a new top-level post', async () => {
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/repos/x/y/issues') && init.method === 'POST') {
      assert.deepEqual(JSON.parse(init.body), { title: 'Release notes', body: 'v1.2.3 shipped' });
      return fakeResponse({ status: 201, json: { number: 99, html_url: 'https://github.com/x/y/issues/99' } });
    }
    throw new Error(`unexpected url ${u}`);
  };
  const conn = new GitHubConnector(makeCred(), { targets: ['x/y'], fetchImpl, sleepImpl: noopSleep });
  const result = await conn.publish({ target: 'x/y', title: 'Release notes', body: 'v1.2.3 shipped' });
  assert.equal(result.external_item_id, 'issue:x/y#99');
  assert.equal(result.permalink, 'https://github.com/x/y/issues/99');
});

test('publish rejects a target outside the whitelist WITHOUT making any network call', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(String(url)); return fakeResponse({}); };
  const conn = new GitHubConnector(makeCred(), { targets: ['x/y'], fetchImpl, sleepImpl: noopSleep });
  await assert.rejects(conn.publish({ target: 'other/repo', title: 't', body: 'b' }), GitHubApiError);
  assert.equal(calls.length, 0);
});

test('reply posts an issue comment and rejects a malformed threadRef', async () => {
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.includes('/repos/x/y/issues/1/comments') && init.method === 'POST') {
      return fakeResponse({ status: 201, json: { id: 777, html_url: 'https://github.com/x/y/issues/1#issuecomment-777' } });
    }
    throw new Error(`unexpected url ${u}`);
  };
  const conn = new GitHubConnector(makeCred(), { targets: ['x/y'], fetchImpl, sleepImpl: noopSleep });
  const result = await conn.reply('issue:x/y#1', 'this has been resolved');
  assert.equal(result.external_item_id, 'comment:x/y#1:777');
  assert.equal(result.permalink, 'https://github.com/x/y/issues/1#issuecomment-777');

  await assert.rejects(conn.reply('not-a-ref', 'x'), GitHubApiError);
});

test('close PATCHes the issue to state=closed', async () => {
  let closeCalled = false;
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/repos/x/y/issues/1') && init.method === 'PATCH') {
      closeCalled = true;
      assert.deepEqual(JSON.parse(init.body), { state: 'closed' });
      return fakeResponse({ status: 200, json: { number: 1, state: 'closed' } });
    }
    throw new Error(`unexpected url ${u}`);
  };
  const conn = new GitHubConnector(makeCred(), { targets: ['x/y'], fetchImpl, sleepImpl: noopSleep });
  await conn.close('issue:x/y#1');
  assert.ok(closeCalled);
});

test('close rejects a target outside the whitelist WITHOUT making any network call', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(String(url)); return fakeResponse({}); };
  const conn = new GitHubConnector(makeCred(), { targets: ['x/y'], fetchImpl, sleepImpl: noopSleep });
  await assert.rejects(conn.close('issue:other/repo#1'), GitHubApiError);
  assert.equal(calls.length, 0);
});

test('403 WITHOUT a Retry-After header is a hard failure — never retried', async () => {
  let attempts = 0;
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.endsWith('/user')) return fakeResponse({ json: { login: 'awb-bot' } });
    attempts++;
    return fakeResponse({ status: 403, text: 'Bad credentials' });
  };
  const conn = new GitHubConnector(makeCred(), { targets: ['x/y'], fetchImpl, sleepImpl: noopSleep });
  await assert.rejects(conn.fetchInbound(''), GitHubForbiddenError);
  assert.equal(attempts, 1, '403 without Retry-After triggers exactly one attempt — no retry');
});

test('403 WITH a Retry-After header (secondary rate limit) backs off then succeeds', async () => {
  let attempts = 0;
  const sleeps = [];
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.endsWith('/user')) return fakeResponse({ json: { login: 'awb-bot' } });
    attempts++;
    if (attempts < 2) return fakeResponse({ status: 403, headers: { 'retry-after': '2' }, text: 'secondary rate limit' });
    return fakeResponse({ json: [] });
  };
  const sleepImpl = async (ms) => { sleeps.push(ms); };
  const conn = new GitHubConnector(makeCred(), { targets: ['x/y'], fetchImpl, sleepImpl });
  const items = await conn.fetchInbound('');
  assert.deepEqual(items, []);
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [2000]);
});

test('429 (primary rate limit) backs off then succeeds within the retry budget', async () => {
  let attempts = 0;
  const sleeps = [];
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.endsWith('/user')) return fakeResponse({ json: { login: 'awb-bot' } });
    attempts++;
    if (attempts < 3) return fakeResponse({ status: 429, headers: { 'retry-after': '1' } });
    return fakeResponse({ json: [] });
  };
  const sleepImpl = async (ms) => { sleeps.push(ms); };
  const conn = new GitHubConnector(makeCred(), { targets: ['x/y'], fetchImpl, sleepImpl });
  const items = await conn.fetchInbound('');
  assert.deepEqual(items, []);
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [1000, 1000]);
});

test('rate_limit_per_hour cap throws OutreachChannelRateLimitedError before the network call once exceeded', async () => {
  const limiter = new OutreachRateLimiter();
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.endsWith('/user')) return fakeResponse({ json: { login: 'awb-bot' } });
    if (u.includes('/issues?')) return fakeResponse({ json: [] });
    throw new Error(`unexpected url ${u}`);
  };
  const conn = new GitHubConnector(makeCred(), {
    targets: ['x/y'], fetchImpl, sleepImpl: noopSleep, channelId: 'ch-1', rateLimitPerHour: 2, rateLimiter: limiter,
  });
  // First poll spends exactly 2 calls (GET /user, cached after + GET issues).
  await conn.fetchInbound('');
  // Second poll only needs 1 more call (issues; bot login is cached) — the
  // 3rd call overall exceeds the cap of 2.
  await assert.rejects(conn.fetchInbound(''), OutreachChannelRateLimitedError);
});
