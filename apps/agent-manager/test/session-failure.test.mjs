import test from 'node:test';
import assert from 'node:assert/strict';
import { describeSessionFailure } from '../dist/lib/session-failure.js';
import { opencodeSessionStore } from '../dist/lib/clis/opencode/sessions.js';
import { AgentSessionStore } from '../dist/lib/agent-session-store.js';

const generic = { message: 'Internal error: The request contains invalid parameters.', rpcCode: -32603 };
const failed = {
  role: 'assistant', providerID: 'opencode-go', modelID: 'muse-spark-1.3-contributor',
  error: { name: 'APIError', data: {
    statusCode: 400, message: 'The request contains invalid parameters.',
    responseHeaders: { authorization: 'SECRET_HEADER' },
    metadata: { url: 'https://example.test/?key=SECRET_URL' },
    responseBody: JSON.stringify({ error: { type: 'invalid_request_error', code: null, param: null }, request: 'SECRET_PROMPT' }),
  } },
};
function context(message = failed, created = 2000) {
  const queries = [];
  return { queries, ctx: { exec: async (_bin, args) => {
    queries.push(args[1]);
    return JSON.stringify(args[1].includes('time_created >=')
      ? [{ data: JSON.stringify(message), time_created: created }]
      : [{ data: JSON.stringify({ tokens: { total: 1016258, input: 318, output: 147, cache: { read: 1015793 } } }) }]);
  } } };
}

test('OpenCode opaque 400 includes provider, HTTP status, cached context and qualified recovery advice', async () => {
  const { ctx, queries } = context();
  const details = await opencodeSessionStore.readTurnFailure(ctx, 'ses_failure', 1900);
  const result = describeSessionFailure(generic, details);
  assert.match(result, /HTTP 400/);
  assert.match(result, /opencode-go\/muse-spark/);
  assert.match(result, /1,016,258 tokens/);
  assert.match(result, /not the failed request/);
  assert.match(result, /does not establish/);
  assert.match(result, /Possible causes/);
  assert.match(result, /\/compact/);
  assert.doesNotMatch(result, /provider reports that the conversation exceeds|SECRET/);
  assert.doesNotMatch(JSON.stringify(details), /SECRET/);
  assert.match(queries[0], /time_created >= 1900/);
  assert.match(queries[1], /time_created <= 2000/);
  assert.match(queries[1], /providerID.*opencode-go/);
});

test('old failures and successful latest messages cannot explain a new turn failure', async () => {
  assert.equal(await opencodeSessionStore.readTurnFailure(context(failed, 1800).ctx, 'ses_failure', 1900), null);
  assert.equal(await opencodeSessionStore.readTurnFailure(context({ role: 'assistant', finish: 'stop' }).ctx, 'ses_failure', 1900), null);
});

test('explicit provider context errors give a diagnosis; auth/quota/server errors give different actions', () => {
  const context = describeSessionFailure(generic, { status: 400, providerCode: 'context_length_exceeded', compactCommand: '/compact' });
  assert.match(context, /provider reports that the conversation exceeds/);
  assert.match(context, /\/compact/);
  for (const [status, expected] of [[401, /credential/], [403, /credential/], [429, /rate or quota/], [503, /server error/]]) {
    const result = describeSessionFailure(generic, { status });
    assert.match(result, expected);
    assert.doesNotMatch(result, /Possible causes|\/compact/);
  }
});

test('ACP structured data is used without native evidence and does not dump arbitrary data', () => {
  const result = describeSessionFailure({ ...generic, data: { statusCode: 400, error: { code: 'invalid_value', param: 'temperature', message: 'Unsupported temperature' }, headers: { authorization: 'SECRET' } } });
  assert.match(result, /Parameter: temperature/);
  assert.match(result, /Unsupported temperature/);
  assert.doesNotMatch(result, /SECRET/);
});

test('diagnostic lookup is best effort and validates the session id before SQL', async () => {
  let calls = 0;
  const store = new AgentSessionStore({ opencodeQuery: async () => { calls++; throw new Error('unavailable'); } });
  assert.equal(await store.readTurnFailure('opencode', "x'; DROP TABLE message;--", 1900), null);
  assert.equal(calls, 0);
  assert.equal(await store.readTurnFailure('opencode', 'ses_failure', NaN), null);
  assert.equal(await store.readTurnFailure('opencode', 'ses_failure', 1900), null);
  assert.equal(calls, 1);
});
