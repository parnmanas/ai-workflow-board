// Android 앱 로그인 — 단말 자격(UserDevice)과 구글 로그인 왕복(PKCE).
//
// 고정하는 것:
//   1. 단말 토큰은 원문이 DB 에 남지 않고, 세션을 다시 받는 데에만 쓰인다. 회수하면 즉시 끝난다.
//      막힌 사용자에게는 세션을 내주지 않는다.
//   2. 구글 로그인 state 는 무작위 · 한 번만 · 만료가 있다(전에는 고정 문자열 'awb').
//   3. 앱 교환 코드는 verifier 없이는 세션이 되지 않고, 틀린 verifier 한 번이면 코드가 버려진다.
//   4. callback 은 모르는 state 를 거절하고, 앱 로그인이면 웹 화면 대신 awb://oauth 로 돌려보낸다.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';
import { User } from '../dist/entities/User.js';
import { UserDevice } from '../dist/entities/UserDevice.js';
import { AuthService } from '../dist/services/auth.service.js';
import { MemoryMetricsRegistry } from '../dist/services/memory-metrics.registry.js';
import { LogService } from '../dist/services/log.service.js';
import { DeviceAuthService, hashDeviceToken } from '../dist/modules/auth/device-auth.service.js';
import { OAuthFlowStore, s256, APP_CODE_TTL_MS, OAUTH_STATE_TTL_MS } from '../dist/modules/auth/oauth-flow.js';
import { AuthController } from '../dist/modules/auth/auth.controller.js';

const VERIFIER = 'v'.repeat(20) + 'erifier-0123456789abcdefghijklmnop';

function fakeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    redirectedTo: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    redirect(url) { this.redirectedTo = url; return this; },
  };
  return res;
}

function fakeReq() {
  return { protocol: 'https', get: (h) => (h === 'host' ? 'awb.example.com' : undefined) };
}

describe('Android app device credentials', () => {
  let ds;
  let users;
  let devices;
  let authService;
  let deviceAuth;
  let user;

  before(async () => {
    ds = new DataSource({ type: 'sqljs', entities: [User, UserDevice], synchronize: true, logging: false });
    await ds.initialize();
    users = ds.getRepository(User);
    devices = ds.getRepository(UserDevice);
  });

  after(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  beforeEach(async () => {
    await devices.clear();
    await users.clear();
    user = await users.save(users.create({ name: 'Phone Owner', email: 'phone@example.com', role: 'admin', status: 'active' }));
    authService = new AuthService(users, new MemoryMetricsRegistry(), new LogService());
    deviceAuth = new DeviceAuthService(devices, users, authService);
  });

  it('stores only the hash and mints sessions the AuthGuard accepts', async () => {
    const { device_id, device_token } = await deviceAuth.register(user.id, { name: 'Pixel 9', platform: 'android', app_version: '2.0.0' });
    assert.match(device_token, /^awbd_[0-9a-f]{64}$/);
    const row = await devices.findOneByOrFail({ id: device_id });
    assert.notEqual(row.token_hash, device_token);
    assert.equal(row.token_hash, hashDeviceToken(device_token));

    const minted = await deviceAuth.mintSession(device_token, '2.0.1');
    assert.ok(minted?.token);
    assert.equal((await authService.getSessionUser(minted.token))?.id, user.id);
    assert.equal((await devices.findOneByOrFail({ id: device_id })).app_version, '2.0.1');
  });

  it('survives a server restart: a fresh AuthService still mints from the stored device', async () => {
    const { device_token } = await deviceAuth.register(user.id, { name: 'Pixel 9' });
    const restarted = new AuthService(users, new MemoryMetricsRegistry(), new LogService());
    const minted = await new DeviceAuthService(devices, users, restarted).mintSession(device_token);
    assert.equal((await restarted.getSessionUser(minted.token))?.id, user.id);
  });

  it('refuses revoked devices, unknown tokens and blocked users', async () => {
    const a = await deviceAuth.register(user.id, { name: 'A' });
    assert.equal(await deviceAuth.mintSession('awbd_' + '0'.repeat(64)), null);
    assert.equal(await deviceAuth.mintSession('not-a-device-token'), null);
    assert.equal(await deviceAuth.revokeToken(a.device_token), true);
    assert.equal(await deviceAuth.mintSession(a.device_token), null);

    const b = await deviceAuth.register(user.id, { name: 'B' });
    await users.update({ id: user.id }, { status: 'rejected' });
    assert.equal(await deviceAuth.mintSession(b.device_token), null);
  });

  it('lists and revokes only the caller\'s own devices', async () => {
    const mine = await deviceAuth.register(user.id, { name: 'Mine' });
    const other = await users.save(users.create({ name: 'Other', email: 'other@example.com', role: 'user', status: 'active' }));
    const theirs = await deviceAuth.register(other.id, { name: 'Theirs' });
    assert.deepEqual((await deviceAuth.listForUser(user.id)).map((d) => d.name), ['Mine']);
    assert.equal(await deviceAuth.revokeForUser(user.id, theirs.device_id), false);
    assert.equal(await deviceAuth.revokeForUser(user.id, mine.device_id), true);
    assert.deepEqual(await deviceAuth.listForUser(user.id), []);
    assert.ok(await deviceAuth.mintSession(theirs.device_token));
  });
});

describe('Google OAuth round trip state and PKCE app codes', () => {
  it('states are single use and expire', () => {
    let now = 1_000_000;
    const store = new OAuthFlowStore(() => now);
    const s = store.issueState({ kind: 'web' });
    assert.deepEqual(store.consumeState(s), { kind: 'web' });
    assert.equal(store.consumeState(s), null);
    assert.equal(store.consumeState('awb'), null, 'the old fixed state must not pass');
    const late = store.issueState({ kind: 'web' });
    now += OAUTH_STATE_TTL_MS + 1;
    assert.equal(store.consumeState(late), null);
  });

  it('app codes need the matching verifier, once, before they expire', () => {
    let now = 5_000_000;
    const store = new OAuthFlowStore(() => now);
    const challenge = s256(VERIFIER);
    const code = store.issueAppCode('session-token', challenge);
    assert.equal(store.exchangeAppCode(code, VERIFIER), 'session-token');
    assert.equal(store.exchangeAppCode(code, VERIFIER), null, 'single use');

    const guessed = store.issueAppCode('session-token', challenge);
    assert.equal(store.exchangeAppCode(guessed, VERIFIER.replace('v', 'w')), null);
    assert.equal(store.exchangeAppCode(guessed, VERIFIER), null, 'a wrong verifier burns the code');

    const stale = store.issueAppCode('session-token', challenge);
    now += APP_CODE_TTL_MS + 1;
    assert.equal(store.exchangeAppCode(stale, VERIFIER), null);
  });

  it('s256 matches RFC 7636 appendix B', () => {
    assert.equal(s256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

describe('AuthController OAuth app endpoints', () => {
  function controller({ googleUser = { sub: 'g-1', email: 'phone@example.com', name: 'P', picture: '' } } = {}) {
    const issued = [];
    const auth = {
      loginOrCreateGoogleUser: async () => ({ token: 'tok-from-google', user: {} }),
    };
    const google = {
      getAuthUrl: async (redirectUri, state) => { issued.push({ redirectUri, state }); return `https://accounts.google.com/o?state=${state}`; },
      exchangeCodeForUser: async () => googleUser,
    };
    const c = new AuthController(auth, google, {}, {}, {}, {});
    return { c, issued };
  }

  it('rejects an app start without a valid S256 challenge', async () => {
    const { c } = controller();
    const res = fakeRes();
    await c.googleOAuthStart('android', 'too-short', fakeReq(), res);
    assert.equal(res.statusCode, 400);
  });

  it('sends the app back to awb://oauth with a code only its verifier can redeem', async () => {
    const { c, issued } = controller();
    const start = fakeRes();
    await c.googleOAuthStart('android', s256(VERIFIER), fakeReq(), start);
    assert.match(start.redirectedTo, /^https:\/\/accounts\.google\.com\//);
    const { state } = issued[0];
    assert.notEqual(state, 'awb');

    const cb = fakeRes();
    await c.googleOAuthCallback('google-code', undefined, state, fakeReq(), cb);
    const back = new URL(cb.redirectedTo);
    assert.equal(back.protocol, 'awb:');
    assert.equal(back.host, 'oauth');
    const code = back.searchParams.get('code');
    assert.ok(code && !cb.redirectedTo.includes('tok-from-google'), 'the session token never rides the redirect');

    const wrong = fakeRes();
    c.oauthAppExchange({ code, code_verifier: VERIFIER + 'x' }, wrong);
    assert.equal(wrong.statusCode, 400);
  });

  it('exchanges the code for the session token with the right verifier', async () => {
    const { c, issued } = controller();
    await c.googleOAuthStart('android', s256(VERIFIER), fakeReq(), fakeRes());
    const cb = fakeRes();
    await c.googleOAuthCallback('google-code', undefined, issued[0].state, fakeReq(), cb);
    const code = new URL(cb.redirectedTo).searchParams.get('code');
    const ok = fakeRes();
    c.oauthAppExchange({ code, code_verifier: VERIFIER }, ok);
    assert.deepEqual(ok.body, { token: 'tok-from-google' });
  });

  it('keeps the web flow on /?token= and refuses unknown state', async () => {
    const { c, issued } = controller();
    await c.googleOAuthStart(undefined, undefined, fakeReq(), fakeRes());
    const cb = fakeRes();
    await c.googleOAuthCallback('google-code', undefined, issued[0].state, fakeReq(), cb);
    assert.equal(cb.redirectedTo, '/?token=tok-from-google');

    const forged = fakeRes();
    await c.googleOAuthCallback('google-code', undefined, 'awb', fakeReq(), forged);
    assert.equal(forged.redirectedTo, '/?oauth_error=invalid_state');
  });

  it('reports app-side failures back to the app, not to a web page', async () => {
    const { c, issued } = controller({ googleUser: null });
    await c.googleOAuthStart('android', s256(VERIFIER), fakeReq(), fakeRes());
    const cb = fakeRes();
    await c.googleOAuthCallback('google-code', undefined, issued[0].state, fakeReq(), cb);
    assert.equal(cb.redirectedTo, 'awb://oauth?error=token_exchange_failed');
  });
});

describe('device token hash', () => {
  it('is sha256 hex of the raw token', () => {
    assert.equal(hashDeviceToken('awbd_x'), createHash('sha256').update('awbd_x').digest('hex'));
  });
});
