import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePublicOrigin, requestOrigin, publicBaseUrl, notePublicOrigin, learnedPublicUrl, setConfiguredPublicUrl, oauthCallbackBase } from '../dist/common/public-url.js';

const req = headers => ({ headers, protocol: 'http' });

test('public address: browser origin first, admin-only learning, no downgrade, explicit settings win', () => {
  const env = process.env.AWB_PUBLIC_URL; delete process.env.AWB_PUBLIC_URL;
  try {
    assert.equal(normalizePublicOrigin('https://awb.example.com/path?x'), 'https://awb.example.com');
    assert.equal(normalizePublicOrigin('https://user:pw@awb.example.com'), '');
    assert.equal(normalizePublicOrigin('javascript:alert(1)'), '');
    // Behind a tunnel or dev proxy the Host is internal; the browser's Origin is what the user typed.
    assert.equal(requestOrigin(req({ origin: 'https://awb.example.com', host: '127.0.0.1:7701' })), 'https://awb.example.com');
    assert.equal(requestOrigin(req({ referer: 'https://awb.example.com/business', host: '127.0.0.1:7701' })), 'https://awb.example.com');
    assert.equal(requestOrigin(req({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'awb.example.com', host: '127.0.0.1' })), 'https://awb.example.com');

    assert.equal(publicBaseUrl(), '');
    notePublicOrigin(req({ origin: 'https://evil.example' }), 'user');
    assert.equal(publicBaseUrl(), '', 'ordinary accounts never steer links');
    notePublicOrigin(req({ host: 'awb.example.com' }), 'admin');
    assert.equal(publicBaseUrl(), '', 'a bare Host header is not learned');
    notePublicOrigin(req({ origin: 'https://awb.example.com' }), 'admin');
    assert.equal(learnedPublicUrl(), 'https://awb.example.com');
    notePublicOrigin(req({ origin: 'http://localhost:7700' }), 'admin');
    notePublicOrigin(req({ origin: 'http://192.168.0.3:7701' }), 'admin');
    assert.equal(publicBaseUrl(), 'https://awb.example.com', 'a local or plain-HTTP tab does not replace HTTPS');

    setConfiguredPublicUrl('https://proxy.example.com/awb/');
    assert.equal(publicBaseUrl(), 'https://proxy.example.com/awb');
    process.env.AWB_PUBLIC_URL = 'https://env.example.com/';
    assert.equal(publicBaseUrl(), 'https://env.example.com');
    setConfiguredPublicUrl('');
    delete process.env.AWB_PUBLIC_URL;

    assert.equal(oauthCallbackBase('https://tab.example.com'), 'https://tab.example.com');
    assert.equal(oauthCallbackBase(), 'https://awb.example.com');
    assert.throws(() => oauthCallbackBase('http://lan.example'), /HTTPS/, 'plain HTTP off loopback is refused');
  } finally { if (env === undefined) delete process.env.AWB_PUBLIC_URL; else process.env.AWB_PUBLIC_URL = env; }
});
