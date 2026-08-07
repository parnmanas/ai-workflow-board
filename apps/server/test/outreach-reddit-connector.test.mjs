// Behavioral tests for RedditConnector (ticket d86d0c24 step 2) — drives OAuth
// refresh, publish/reply/fetchInbound, rate-limit backoff, and the
// never-auto-discover-subreddits guarantee entirely against a fake `fetch`
// (the `fetchImpl` constructor seam this ticket introduces — no real network
// call, no npm dependency).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RedditConnector,
  RedditConnectorConfigError,
  RedditForbiddenError,
  RedditRateLimitError,
  RedditApiError,
} from '../dist/modules/outreach/connectors/reddit.connector.js';
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

const TOKEN_OK = () => fakeResponse({ status: 200, json: { access_token: 'tok-abc', expires_in: 3600 } });

function makeCred(extra = {}) {
  return {
    username: 'awb-bot',
    token: 'refresh-token-xyz',
    extra: { client_id: 'cid', client_secret: 'csecret', ...extra },
  };
}

function noopSleep() { return Promise.resolve(); }

test('constructor throws RedditConnectorConfigError when client_id/client_secret missing', () => {
  assert.throws(
    () => new RedditConnector({ username: 'u', token: 't', extra: {} }, { targets: ['awb'], userAgent: 'ua/1.0' }),
    RedditConnectorConfigError,
  );
});

test('constructor throws when userAgent is empty', () => {
  assert.throws(
    () => new RedditConnector(makeCred(), { targets: ['awb'], userAgent: '' }),
    RedditConnectorConfigError,
  );
});

test('OAuth: token endpoint gets Basic auth + refresh_token grant, token is cached across calls', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url === 'https://www.reddit.com/api/v1/access_token') return TOKEN_OK();
    if (String(url).includes('/r/awb/new')) {
      return fakeResponse({ status: 200, json: { data: { children: [] } } });
    }
    throw new Error(`unexpected url ${url}`);
  };
  // No username → fetchInbound skips the own-submissions/comment-tree branch,
  // keeping this test focused purely on the OAuth token lifecycle.
  const cred = { token: 'refresh-token-xyz', extra: { client_id: 'cid', client_secret: 'csecret' } };
  const conn = new RedditConnector(cred, { targets: ['awb'], userAgent: 'ua/1.0', fetchImpl });

  await conn.fetchInbound('');
  await conn.fetchInbound('');

  const tokenCalls = calls.filter((c) => c.url === 'https://www.reddit.com/api/v1/access_token');
  assert.equal(tokenCalls.length, 1, 'token fetched once and cached across two fetchInbound calls');
  const authHeader = tokenCalls[0].init.headers['Authorization'];
  assert.equal(authHeader, `Basic ${Buffer.from('cid:csecret').toString('base64')}`);
  assert.match(tokenCalls[0].init.body, /grant_type=refresh_token/);
  assert.match(tokenCalls[0].init.body, /refresh_token=refresh-token-xyz/);
});

test('script auth_mode uses password grant with username', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url === 'https://www.reddit.com/api/v1/access_token') return TOKEN_OK();
    return fakeResponse({ status: 200, json: { data: { children: [] } } });
  };
  const cred = { username: 'scriptbot', token: 'bot-password', extra: { client_id: 'cid', client_secret: 'csecret', auth_mode: 'script' } };
  const conn = new RedditConnector(cred, { targets: ['awb'], userAgent: 'ua/1.0', fetchImpl });
  await conn.fetchInbound('');

  const tokenCall = calls.find((c) => c.url === 'https://www.reddit.com/api/v1/access_token');
  assert.match(tokenCall.init.body, /grant_type=password/);
  assert.match(tokenCall.init.body, /username=scriptbot/);
  assert.match(tokenCall.init.body, /password=bot-password/);
});

test('401 forces exactly one token refresh + retry, then succeeds', async () => {
  let tokenCalls = 0;
  let submitAttempts = 0;
  const fetchImpl = async (url) => {
    if (url === 'https://www.reddit.com/api/v1/access_token') {
      tokenCalls++;
      return fakeResponse({ status: 200, json: { access_token: `tok-${tokenCalls}`, expires_in: 3600 } });
    }
    if (String(url).includes('/api/submit')) {
      submitAttempts++;
      if (submitAttempts === 1) return fakeResponse({ status: 401, text: 'expired' });
      return fakeResponse({ status: 200, json: { json: { errors: [], data: { name: 't3_new1', url: '/r/awb/comments/new1/x' } } } });
    }
    throw new Error(`unexpected url ${url}`);
  };
  const conn = new RedditConnector(makeCred(), { targets: ['awb'], userAgent: 'ua/1.0', fetchImpl });
  const result = await conn.publish({ target: 'awb', title: 'Release', body: 'notes' });

  assert.equal(submitAttempts, 2, 'submit retried exactly once after 401');
  assert.equal(tokenCalls, 2, 'token was force-refreshed once');
  assert.equal(result.external_item_id, 't3_new1');
  assert.equal(result.permalink, 'https://www.reddit.com/r/awb/comments/new1/x');
});

test('publish rejects a target outside the whitelist WITHOUT making any network call', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return TOKEN_OK(); };
  const conn = new RedditConnector(makeCred(), { targets: ['awb'], userAgent: 'ua/1.0', fetchImpl });
  await assert.rejects(conn.publish({ target: 'other_subreddit', title: 't', body: 'b' }), RedditApiError);
  assert.equal(calls.length, 0, 'no request was made for a non-whitelisted target');
});

test('reply posts a comment and rejects a non-fullname threadRef', async () => {
  const fetchImpl = async (url) => {
    if (url === 'https://www.reddit.com/api/v1/access_token') return TOKEN_OK();
    if (String(url).includes('/api/comment')) {
      return fakeResponse({ status: 200, json: { json: { errors: [], data: { things: [{ data: { name: 't1_reply1', permalink: '/r/awb/comments/x/y/reply1' } }] } } } });
    }
    throw new Error(`unexpected url ${url}`);
  };
  const conn = new RedditConnector(makeCred(), { targets: ['awb'], userAgent: 'ua/1.0', fetchImpl });
  const result = await conn.reply('t3_orig', 'thanks for the report');
  assert.equal(result.external_item_id, 't1_reply1');
  assert.equal(result.permalink, 'https://www.reddit.com/r/awb/comments/x/y/reply1');

  await assert.rejects(conn.reply('not-a-fullname', 'x'), RedditApiError);
});

test('fetchInbound: empty targets makes ZERO network calls (fail-closed, no auto-discovery)', async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return TOKEN_OK(); };
  const conn = new RedditConnector(makeCred(), { targets: [], userAgent: 'ua/1.0', fetchImpl });
  const items = await conn.fetchInbound('');
  assert.deepEqual(items, []);
  assert.equal(calls.length, 0);
});

test('fetchInbound: only hits whitelisted subreddits + own-submission comment trees, never anything else', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));
    if (url === 'https://www.reddit.com/api/v1/access_token') return TOKEN_OK();
    if (String(url).includes('/r/awb/new')) {
      return fakeResponse({
        status: 200,
        json: {
          data: {
            children: [
              { data: { name: 't3_post1', title: 'Hello', selftext: 'body', author: 'someone', permalink: '/r/awb/comments/post1/hello', created_utc: 1000 } },
            ],
          },
        },
      });
    }
    if (String(url).includes('/user/awb-bot/submitted')) {
      return fakeResponse({
        status: 200,
        json: { data: { children: [{ data: { id: 'myid', subreddit: 'awb' } }] } },
      });
    }
    if (String(url).includes('/comments/myid')) {
      return fakeResponse({
        status: 200,
        json: [
          {},
          { data: { children: [{ kind: 't1', data: { name: 't1_c1', body: 'nice work', author: 'fan', permalink: '/r/awb/comments/myid/x/c1', created_utc: 2000, replies: '' } }] } },
        ],
      });
    }
    throw new Error(`unexpected url ${url}`);
  };
  const conn = new RedditConnector(makeCred(), { targets: ['awb'], userAgent: 'ua/1.0', fetchImpl });
  const items = await conn.fetchInbound('');

  const nonWhitelisted = urls.filter((u) => u.includes('/r/') && !u.includes('/r/awb/'));
  assert.equal(nonWhitelisted.length, 0, 'no request ever touches a subreddit outside targets');

  const ids = items.map((i) => i.external_item_id).sort();
  assert.deepEqual(ids, ['t1_c1', 't3_post1']);
  // oldest first
  assert.ok(items[0].created_at.getTime() <= items[1].created_at.getTime());
});

test('fetchInbound: since cursor filters out items at/before the cursor', async () => {
  const fetchImpl = async (url) => {
    if (url === 'https://www.reddit.com/api/v1/access_token') return TOKEN_OK();
    if (String(url).includes('/r/awb/new')) {
      return fakeResponse({
        status: 200,
        json: {
          data: {
            children: [
              { data: { name: 't3_old', title: 'old', selftext: '', author: 'a', permalink: '/x', created_utc: 1000 } },
              { data: { name: 't3_new', title: 'new', selftext: '', author: 'a', permalink: '/y', created_utc: 5000 } },
            ],
          },
        },
      });
    }
    throw new Error(`unexpected url ${url}`);
  };
  const cred = { token: 'refresh-token-xyz', extra: { client_id: 'cid', client_secret: 'csecret' } }; // no username → skip own-post comments
  const conn = new RedditConnector(cred, { targets: ['awb'], userAgent: 'ua/1.0', fetchImpl });
  const items = await conn.fetchInbound(new Date(2000 * 1000).toISOString());
  assert.deepEqual(items.map((i) => i.external_item_id), ['t3_new']);
});

test('403 is never retried and throws RedditForbiddenError immediately', async () => {
  let attempts = 0;
  const fetchImpl = async (url) => {
    if (url === 'https://www.reddit.com/api/v1/access_token') return TOKEN_OK();
    attempts++;
    return fakeResponse({ status: 403, text: 'banned from subreddit' });
  };
  const conn = new RedditConnector(makeCred(), { targets: ['awb'], userAgent: 'ua/1.0', fetchImpl });
  await assert.rejects(conn.fetchInbound(''), RedditForbiddenError);
  assert.equal(attempts, 1, '403 triggers exactly one attempt — no retry');
});

test('429 backs off (Retry-After header) then succeeds within the retry budget', async () => {
  let attempts = 0;
  const sleeps = [];
  const fetchImpl = async (url) => {
    if (url === 'https://www.reddit.com/api/v1/access_token') return TOKEN_OK();
    attempts++;
    if (attempts < 3) return fakeResponse({ status: 429, headers: { 'retry-after': '2' } });
    return fakeResponse({ status: 200, json: { data: { children: [] } } });
  };
  const sleepImpl = async (ms) => { sleeps.push(ms); };
  const cred = { token: 'refresh-token-xyz', extra: { client_id: 'cid', client_secret: 'csecret' } }; // no username → single-endpoint call chain
  const conn = new RedditConnector(cred, { targets: ['awb'], userAgent: 'ua/1.0', fetchImpl, sleepImpl });
  const items = await conn.fetchInbound('');
  assert.deepEqual(items, []);
  assert.equal(attempts, 3, 'two 429s then a success');
  assert.deepEqual(sleeps, [2000, 2000], 'backoff waited Retry-After seconds each time');
});

test('429 exceeding the retry budget throws RedditRateLimitError', async () => {
  const fetchImpl = async (url) => {
    if (url === 'https://www.reddit.com/api/v1/access_token') return TOKEN_OK();
    return fakeResponse({ status: 429, headers: { 'retry-after': '0' } });
  };
  const conn = new RedditConnector(makeCred(), { targets: ['awb'], userAgent: 'ua/1.0', fetchImpl, sleepImpl: noopSleep });
  await assert.rejects(conn.fetchInbound(''), RedditRateLimitError);
});

test('submit-level API errors (json.errors non-empty) throw RedditApiError without retry', async () => {
  let attempts = 0;
  const fetchImpl = async (url) => {
    if (url === 'https://www.reddit.com/api/v1/access_token') return TOKEN_OK();
    attempts++;
    return fakeResponse({ status: 200, json: { json: { errors: [['RATELIMIT', 'you are doing that too much', 'ratelimit']] } } });
  };
  const conn = new RedditConnector(makeCred(), { targets: ['awb'], userAgent: 'ua/1.0', fetchImpl });
  await assert.rejects(conn.publish({ target: 'awb', title: 't', body: 'b' }), RedditApiError);
  assert.equal(attempts, 1);
});

test('every request carries the configured User-Agent header', async () => {
  const uas = [];
  const fetchImpl = async (url, init) => {
    uas.push(init.headers['User-Agent']);
    if (url === 'https://www.reddit.com/api/v1/access_token') return TOKEN_OK();
    return fakeResponse({ status: 200, json: { data: { children: [] } } });
  };
  const conn = new RedditConnector(makeCred(), { targets: ['awb'], userAgent: 'AwbOutreachBot/1.0 (by u/awb-bot)', fetchImpl });
  await conn.fetchInbound('');
  assert.ok(uas.every((ua) => ua === 'AwbOutreachBot/1.0 (by u/awb-bot)'));
});

// ── rate_limit_per_hour operator cap (review fix #1) ─────────────────────────

// No username on this credential: fetchInbound then makes exactly ONE
// internal request per target (the /r/{sub}/new listing) — WITH a username
// (makeCred()'s default) it would also fetch the bot's own-submissions
// comment trees, consuming a second rate-limit slot within a single
// fetchInbound() call and making the cap math below non-obvious.
function noUsernameCred() {
  return { token: 'refresh-token-xyz', extra: { client_id: 'cid', client_secret: 'csecret' } };
}

test('rate_limit_per_hour: the call that would exceed the cap throws OutreachChannelRateLimitedError and makes NO network call', async () => {
  let apiCalls = 0;
  const fetchImpl = async (url) => {
    if (url === 'https://www.reddit.com/api/v1/access_token') return TOKEN_OK();
    apiCalls++;
    return fakeResponse({ status: 200, json: { data: { children: [] } } });
  };
  const rateLimiter = new OutreachRateLimiter();
  const conn = new RedditConnector(noUsernameCred(), {
    targets: ['awb'], userAgent: 'ua/1.0', fetchImpl, channelId: 'ch-1', rateLimitPerHour: 1, rateLimiter,
  });
  await conn.fetchInbound(''); // consumes the single allowed slot
  assert.equal(apiCalls, 1);
  await assert.rejects(conn.fetchInbound(''), OutreachChannelRateLimitedError);
  assert.equal(apiCalls, 1, 'the blocked call never reached the network');
});

test('rate_limit_per_hour is shared across DIFFERENT RedditConnector instances for the SAME channel_id (matches production: a fresh connector is built per call site)', async () => {
  const fetchImpl = async (url) => {
    if (url === 'https://www.reddit.com/api/v1/access_token') return TOKEN_OK();
    return fakeResponse({ status: 200, json: { data: { children: [] } } });
  };
  const rateLimiter = new OutreachRateLimiter();
  const opts = { targets: ['awb'], userAgent: 'ua/1.0', fetchImpl, channelId: 'ch-shared', rateLimitPerHour: 1, rateLimiter };
  const connA = new RedditConnector(noUsernameCred(), opts);
  const connB = new RedditConnector(noUsernameCred(), opts);
  await connA.fetchInbound('');
  await assert.rejects(connB.fetchInbound(''), OutreachChannelRateLimitedError);
});

test('rateLimitPerHour omitted (default 0) is unlimited — the operator cap never applies', async () => {
  const fetchImpl = async (url) => {
    if (url === 'https://www.reddit.com/api/v1/access_token') return TOKEN_OK();
    return fakeResponse({ status: 200, json: { data: { children: [] } } });
  };
  const conn = new RedditConnector(makeCred(), { targets: ['awb'], userAgent: 'ua/1.0', fetchImpl, channelId: 'ch-1' });
  await conn.fetchInbound('');
  await conn.fetchInbound('');
  await conn.fetchInbound('');
  // no throw — reaching here is the assertion.
});

// ── proactive success-response rate-limit-header handling (review fix #1) ────

test('a SUCCESS response reporting x-ratelimit-remaining=0 makes the NEXT request wait for x-ratelimit-reset, instead of waiting for an actual 429', async () => {
  const sleeps = [];
  let calls = 0;
  const fetchImpl = async (url) => {
    if (url === 'https://www.reddit.com/api/v1/access_token') return TOKEN_OK();
    calls++;
    if (calls === 1) {
      return fakeResponse({
        status: 200,
        json: { data: { children: [] } },
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '5' },
      });
    }
    return fakeResponse({ status: 200, json: { data: { children: [] } } });
  };
  const sleepImpl = async (ms) => { sleeps.push(ms); };
  // Fixed clock — the proactive wait computes (capturedResetAtMs - now()),
  // so pinning `now` keeps the expected wait EXACTLY 5000ms regardless of
  // real wall-clock time elapsed between the two internal _request() calls.
  const now = () => 1_700_000_000_000;
  // no username → fetchInbound only hits /r/{sub}/new per target, keeping the
  // call count deterministic (two targets = two sequential requests).
  const cred = { token: 'refresh-token-xyz', extra: { client_id: 'cid', client_secret: 'csecret' } };
  const conn = new RedditConnector(cred, { targets: ['awb', 'awb2'], userAgent: 'ua/1.0', fetchImpl, sleepImpl, now });

  await conn.fetchInbound('');

  assert.equal(calls, 2, 'both subreddits were fetched — no 429 ever occurred');
  assert.deepEqual(sleeps, [5000], 'waited exactly 5s (x-ratelimit-reset) proactively before the second request');
});

test('proactive wait is capped at MAX_BACKOFF_MS even when x-ratelimit-reset reports a much longer window', async () => {
  const sleeps = [];
  let calls = 0;
  const fetchImpl = async (url) => {
    if (url === 'https://www.reddit.com/api/v1/access_token') return TOKEN_OK();
    calls++;
    if (calls === 1) {
      return fakeResponse({
        status: 200,
        json: { data: { children: [] } },
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '600' }, // 10 minutes
      });
    }
    return fakeResponse({ status: 200, json: { data: { children: [] } } });
  };
  const sleepImpl = async (ms) => { sleeps.push(ms); };
  const now = () => 1_700_000_000_000;
  const cred = { token: 'refresh-token-xyz', extra: { client_id: 'cid', client_secret: 'csecret' } };
  const conn = new RedditConnector(cred, { targets: ['awb', 'awb2'], userAgent: 'ua/1.0', fetchImpl, sleepImpl, now });

  await conn.fetchInbound('');

  assert.deepEqual(sleeps, [30000], 'capped at the 30s MAX_BACKOFF_MS ceiling, not the full 600s reset window');
});

test('a SUCCESS response reporting x-ratelimit-remaining > 0 never triggers a proactive wait', async () => {
  const sleeps = [];
  const fetchImpl = async (url) => {
    if (url === 'https://www.reddit.com/api/v1/access_token') return TOKEN_OK();
    return fakeResponse({
      status: 200,
      json: { data: { children: [] } },
      headers: { 'x-ratelimit-remaining': '5', 'x-ratelimit-reset': '30' },
    });
  };
  const sleepImpl = async (ms) => { sleeps.push(ms); };
  const cred = { token: 'refresh-token-xyz', extra: { client_id: 'cid', client_secret: 'csecret' } };
  const conn = new RedditConnector(cred, { targets: ['awb', 'awb2'], userAgent: 'ua/1.0', fetchImpl, sleepImpl });

  await conn.fetchInbound('');

  assert.deepEqual(sleeps, [], 'plenty of budget remaining — no wait');
});

test('RedditRateLimitError thrown after exhausting retries carries a positive retryAfterMs', async () => {
  const fetchImpl = async (url) => {
    if (url === 'https://www.reddit.com/api/v1/access_token') return TOKEN_OK();
    return fakeResponse({ status: 429, headers: { 'retry-after': '3' } });
  };
  const conn = new RedditConnector(makeCred(), { targets: ['awb'], userAgent: 'ua/1.0', fetchImpl, sleepImpl: noopSleep });
  try {
    await conn.fetchInbound('');
    assert.fail('expected throw');
  } catch (e) {
    assert.ok(e instanceof RedditRateLimitError);
    assert.equal(e.retryAfterMs, 3000);
  }
});
