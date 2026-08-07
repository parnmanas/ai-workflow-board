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
