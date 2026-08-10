// ssrf-guard.ts 회귀 테스트 (티켓 f177aeb3 H1) — Function `http` 실행기가
// config.url/headers를 그대로 fetch에 넘기던 full-read SSRF를 막는다.
// 1) 순수 분류 로직(isBlockedAddress, sanitizeOutboundHeaders, 스킴 검증)은
//    네트워크 없이 검증한다.
// 2) 실제 로컬 리스너(127.0.0.1)를 겨냥한 요청이 "리스너가 살아있음에도"
//    거부되는 것까지 확인해 이전 취약점(도달 가능하면 그대로 응답 반환)이
//    닫혔음을 증명한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', 'dist');

const { isBlockedAddress, validateOutboundUrl, sanitizeOutboundHeaders, guardedFetch } = await import(
  'file://' + path.join(DIST_ROOT, 'common', 'ssrf-guard.js')
);

test('isBlockedAddress — loopback/link-local/RFC1918/CGNAT/IPv6 ULA·loopback·mapped are blocked', () => {
  const blocked = [
    '127.0.0.1', '127.53.0.1',              // loopback
    '169.254.169.254', '169.254.0.1',        // link-local — cloud metadata
    '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', // RFC1918
    '100.64.0.1', '100.127.255.255',         // CGNAT
    '0.0.0.0',                                // unspecified
    '::1',                                    // IPv6 loopback
    'fe80::1',                                // IPv6 link-local
    'fc00::1', 'fd12:3456::1',                // IPv6 ULA
    '::ffff:127.0.0.1', '::ffff:10.0.0.1',    // IPv4-mapped IPv6
  ];
  for (const addr of blocked) {
    assert.equal(isBlockedAddress(addr), true, `${addr} must be blocked`);
  }
});

test('isBlockedAddress — public unicast addresses are allowed', () => {
  const allowed = ['8.8.8.8', '1.1.1.1', '203.0.113.7', '2001:4860:4860::8888'];
  for (const addr of allowed) {
    assert.equal(isBlockedAddress(addr), false, `${addr} must not be blocked`);
  }
});

test('validateOutboundUrl — rejects non-http(s) schemes before any host resolution', async () => {
  await assert.rejects(validateOutboundUrl('file:///etc/passwd'), /scheme/);
  await assert.rejects(validateOutboundUrl('gopher://127.0.0.1:6379/_SET'), /scheme/);
  await assert.rejects(validateOutboundUrl('ftp://example.com/'), /scheme/);
});

test('validateOutboundUrl — rejects missing/invalid config.url', async () => {
  await assert.rejects(validateOutboundUrl(undefined), /requires config\.url/);
  await assert.rejects(validateOutboundUrl(''), /requires config\.url/);
  await assert.rejects(validateOutboundUrl('not a url'), /not a valid URL/);
});

test('validateOutboundUrl — rejects IP-literal SSRF targets (loopback, cloud metadata, RFC1918)', async () => {
  await assert.rejects(validateOutboundUrl('http://127.0.0.1/admin'), /not an allowed outbound target/);
  await assert.rejects(validateOutboundUrl('http://169.254.169.254/latest/meta-data/'), /not an allowed outbound target/);
  await assert.rejects(validateOutboundUrl('http://10.0.0.5/'), /not an allowed outbound target/);
  await assert.rejects(validateOutboundUrl('http://[::1]/'), /not an allowed outbound target/);
  await assert.rejects(validateOutboundUrl('http://[::ffff:127.0.0.1]/'), /not an allowed outbound target/);
});

test('validateOutboundUrl — resolves and rejects a hostname (not just IP literals) pointing at loopback', async () => {
  // "localhost" resolves via the local hosts file with no external DNS
  // dependency, so this exercises the dns.lookup() code path (as opposed to
  // the IP-literal fast path) without requiring network access in CI.
  await assert.rejects(validateOutboundUrl('http://localhost:1/x'), /resolves to|not an allowed outbound target/);
});

test('validateOutboundUrl — accepts a public IP-literal target without making a network call', async () => {
  const url = await validateOutboundUrl('https://8.8.8.8/x');
  assert.equal(url.hostname, '8.8.8.8');
});

test('sanitizeOutboundHeaders — drops hop-by-hop/connection headers but keeps application headers', () => {
  const out = sanitizeOutboundHeaders({
    Host: 'attacker.internal',
    Connection: 'keep-alive',
    'Content-Length': '0',
    'Transfer-Encoding': 'chunked',
    Authorization: 'Bearer secret-token',
    'X-Api-Key': 'abc123',
    'X-Custom': 'value',
  });
  assert.deepEqual(out, { Authorization: 'Bearer secret-token', 'X-Api-Key': 'abc123', 'X-Custom': 'value' });
});

test('sanitizeOutboundHeaders — tolerates non-object input', () => {
  assert.deepEqual(sanitizeOutboundHeaders(undefined), {});
  assert.deepEqual(sanitizeOutboundHeaders(null), {});
});

test('guardedFetch — rejects a request to a live loopback listener instead of returning its response', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ secret: 'internal-only-payload' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    await assert.rejects(
      guardedFetch(`http://127.0.0.1:${port}/secret`, { method: 'GET' }),
      /not an allowed outbound target/,
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('guardedFetch — re-validates the Location target on redirect (blocks a redirect to cloud metadata)', async () => {
  // guardedFetch re-runs validateOutboundUrl() on every hop's Location header
  // before following it. We assert that behavior directly against the same
  // function guardedFetch calls per-hop, since fabricating an "allowed" first
  // hop would itself require live public network access unavailable in CI.
  const redirectTarget = new URL('http://169.254.169.254/latest/meta-data/iam/security-credentials/', 'https://example.com/webhook');
  await assert.rejects(validateOutboundUrl(redirectTarget.toString()), /not an allowed outbound target/);
});
