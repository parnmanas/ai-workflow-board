// SSRF 방어 — Function `http` 실행기(workflow-functions.service.ts)가 호출하는
// 아웃바운드 요청 전용 가드. config.url/method/headers/body는 워크스페이스
// 스코프 에이전트가 자유롭게 지정한 Function 정의에서 오므로, 클라우드 메타데이터
// (169.254.169.254)나 내부 서비스로 향하는 요청과 그 응답 본문 전체 노출(full-read
// SSRF)을 막는다. (티켓 f177aeb3 H1, 리뷰 승인 차단 반영)
//
// 방어 계층:
//  1. 스킴 allowlist(http/https) — file:/gopher:/dict: 등 프로토콜 스머글링 차단
//  2. 호스트 resolve 후 loopback/link-local/RFC1918/CGNAT/IPv6 ULA·loopback 차단
//  3. undici Agent의 connect.lookup으로 "실제 TCP 연결 시점"에 동일 검증을 반복
//     — 사전 검증과 실제 연결 사이의 DNS rebinding을 완화
//  4. redirect:'manual' + 매 홉마다 재검증 — 첫 홉만 안전하고 리다이렉트로
//     내부망에 도달하는 것을 차단
//  5. 호출자 제공 헤더는 이름 allowlist(denylist 아님)로만 통과시킨다. hop-by-hop
//     헤더는 allowlist에 없으므로 자동으로 제거된다. Authorization/X-Api-Key 같은
//     credential 헤더는 제3자 웹훅 인증에 필요해 allowlist에 있지만 SENSITIVE로
//     표시되며, 리다이렉트 홉의 origin이 최초 요청과 달라지는 순간 guardedFetch가
//     제거한다 — 허용된 웹훅 호스트의 오픈 리다이렉트만으로 credential이 제3자
//     호스트로 새는 것을 막는다.
import { BlockList, isIP } from 'net';
import * as dns from 'dns';
import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';

export const ALLOWED_SCHEMES = new Set(['http:', 'https:']);
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// 비-credential 애플리케이션 헤더 — 항상 통과. hop-by-hop/connection-control
// 헤더(Host/Connection/Content-Length/Transfer-Encoding/Upgrade/Keep-Alive/
// Proxy-Authenticate/Proxy-Authorization/TE/Trailer)와 Cookie는 이 목록에
// 없으므로 자동으로 제거된다 — Function http 실행기가 브라우저 세션 쿠키나
// 프록시 인증을 다룰 정당한 이유가 없다.
const ALLOWED_HEADER_NAMES = new Set([
  'content-type', 'accept', 'user-agent', 'x-request-id', 'x-idempotency-key',
]);

// 제3자 웹훅 인증에 필요해 allowlist에는 있지만 credential을 담는 헤더.
// guardedFetch가 리다이렉트 홉의 origin이 바뀌면 이 헤더들을 제거한다.
const SENSITIVE_HEADER_NAMES = new Set([
  'authorization', 'x-api-key', 'x-webhook-secret', 'x-hub-signature', 'x-hub-signature-256', 'x-signature',
]);

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

export function sanitizeOutboundHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers || typeof headers !== 'object') return out;
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof key !== 'string') continue;
    const lower = key.toLowerCase();
    if (!ALLOWED_HEADER_NAMES.has(lower) && !SENSITIVE_HEADER_NAMES.has(lower)) continue;
    if (value === undefined || value === null) continue;
    out[key] = String(value);
  }
  return out;
}

function originOf(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

function stripSensitiveHeaders(headers: Record<string, string>): void {
  for (const key of Object.keys(headers)) {
    if (SENSITIVE_HEADER_NAMES.has(key.toLowerCase())) delete headers[key];
  }
}

const blockedIPv4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],        // "this network" / unspecified — 유효한 HTTP 대상 아님
  ['10.0.0.0', 8],        // RFC1918
  ['100.64.0.0', 10],     // CGNAT (RFC6598)
  ['127.0.0.0', 8],       // loopback
  ['169.254.0.0', 16],    // link-local — 클라우드 메타데이터(169.254.169.254) 포함
  ['172.16.0.0', 12],     // RFC1918
  ['192.168.0.0', 16],    // RFC1918
  ['224.0.0.0', 4],       // 멀티캐스트 + 예약 대역(224.0.0.0–255.255.255.255)
] as const) {
  blockedIPv4.addSubnet(address, prefix, 'ipv4');
}

const blockedIPv6 = new BlockList();
for (const [address, prefix] of [
  ['::1', 128],     // loopback
  ['::', 128],       // unspecified
  ['fe80::', 10],     // link-local
  ['fc00::', 7],      // ULA
  // IPv4-mapped IPv6(::ffff:a.b.c.d)는 통째로 차단한다 — 매핑된 v4가 공인이든
  // 아니든, 이 리터럴 형식 하나로 위 IPv4 차단표를 우회하지 못하게 막는 편이
  // v4-in-v6 임베딩을 풀어 재검사하는 것보다 안전하고 단순하다. 공인 IPv4
  // 대상은 일반 IPv4 리터럴/도메인으로 접근하면 된다.
  ['::ffff:0:0', 96],
] as const) {
  blockedIPv6.addSubnet(address, prefix, 'ipv6');
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blockedIPv4.check(address, 'ipv4');
  if (family === 6) return blockedIPv6.check(address, 'ipv6');
  return true; // 유효한 IP로 파싱되지 않으면 보수적으로 차단
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

async function assertHostAllowed(hostname: string): Promise<void> {
  const host = stripBrackets(hostname);
  if (isIP(host)) {
    if (isBlockedAddress(host)) {
      throw httpError(400, `SSRF guard: address ${host} is not an allowed outbound target`);
    }
    return;
  }
  let records: dns.LookupAddress[];
  try {
    records = await dns.promises.lookup(host, { all: true, verbatim: true });
  } catch (err: any) {
    throw httpError(400, `SSRF guard: could not resolve host "${host}": ${err?.message || err}`);
  }
  if (!records.length) throw httpError(400, `SSRF guard: host "${host}" did not resolve to any address`);
  for (const record of records) {
    if (isBlockedAddress(record.address)) {
      throw httpError(400, `SSRF guard: host "${host}" resolves to ${record.address}, which is not an allowed outbound target`);
    }
  }
}

/** URL을 파싱하고 스킴·호스트를 검증한다. 리다이렉트 매 홉에서도 재사용된다. */
export async function validateOutboundUrl(rawUrl: unknown): Promise<URL> {
  if (!rawUrl || typeof rawUrl !== 'string') throw httpError(400, 'http executor requires config.url');
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw httpError(400, `http executor config.url is not a valid URL: ${rawUrl}`);
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw httpError(400, `SSRF guard: scheme "${url.protocol}" is not allowed (allowed: ${Array.from(ALLOWED_SCHEMES).join(', ')})`);
  }
  await assertHostAllowed(url.hostname);
  return url;
}

// dns.lookup과 동일한 시그니처. undici Agent의 connect.lookup에 꽂혀 "실제
// TCP 연결 직전"에 다시 검증한다 — validateOutboundUrl의 사전 검증과 실제
// connect 사이에 DNS 응답이 바뀌는 rebinding 공격을 좁힌다.
function guardedLookup(
  hostname: string,
  options: dns.LookupAllOptions | ((err: NodeJS.ErrnoException | null, address: any, family?: number) => void),
  callback?: (err: NodeJS.ErrnoException | null, address: any, family?: number) => void,
): void {
  const cb = typeof options === 'function' ? options : callback!;
  const opts = typeof options === 'function' ? {} : options || {};
  dns.lookup(hostname, { ...opts, all: true, verbatim: true }, (err, addresses) => {
    if (err) return cb(err, undefined as any);
    const list = Array.isArray(addresses) ? addresses : [addresses as any];
    if (!list.length) return cb(Object.assign(new Error(`SSRF guard: DNS resolution for ${hostname} returned no addresses`)) as any, undefined as any);
    for (const entry of list) {
      if (isBlockedAddress(entry.address)) {
        return cb(Object.assign(new Error(`SSRF guard: resolved address ${entry.address} for host "${hostname}" is not allowed`)) as any, undefined as any);
      }
    }
    if ((opts as dns.LookupAllOptions).all) return cb(null, list as any);
    return cb(null, list[0].address, list[0].family);
  });
}

let guardedAgent: Dispatcher | null = null;
function getGuardedAgent(): Dispatcher {
  if (!guardedAgent) guardedAgent = new Agent({ connect: { lookup: guardedLookup as any } });
  return guardedAgent;
}

export interface GuardedFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | undefined;
  signal?: AbortSignal;
}

/**
 * SSRF 가드가 적용된 fetch. 최초 URL과 매 리다이렉트 홉을 모두 스킴/호스트
 * 검증한 뒤에만 요청을 보낸다 — redirect:'manual'로 자동 추적을 막고 직접
 * 각 홉을 재검증하며 따라간다. 301/302(비-GET/HEAD)와 303은 스펙대로 GET+본문
 * 제거로 다운그레이드하고, 307/308은 메서드·본문을 그대로 유지한다. 리다이렉트가
 * origin을 바꾸면(scheme/host/port 중 하나라도 다르면) SENSITIVE_HEADER_NAMES
 * 헤더(Authorization 등)를 다음 홉으로 넘기기 전에 제거한다.
 *
 * `dispatcher`는 테스트에서 undici MockAgent를 주입해 실제 소켓 연결 없이
 * 리다이렉트/헤더 로직을 검증할 수 있게 하는 훅이다 — 프로덕션 호출부는
 * 절대 넘기지 말 것(기본값이 guardedLookup이 꽂힌 실제 SSRF 가드 Agent다).
 */
export async function guardedFetch(
  rawUrl: string,
  init: GuardedFetchInit,
  opts?: { dispatcher?: Dispatcher },
): Promise<Response> {
  let currentUrl = await validateOutboundUrl(rawUrl);
  let method = (init.method || 'GET').toUpperCase();
  let body = init.body;
  const headers = { ...(init.headers || {}) };
  const dispatcher = opts?.dispatcher ?? getGuardedAgent();
  let currentOrigin = originOf(currentUrl);

  for (let hop = 0; ; hop++) {
    const response = await undiciFetch(currentUrl, {
      method,
      headers,
      body,
      signal: init.signal,
      redirect: 'manual',
      dispatcher,
    } as any) as unknown as Response;

    if (!REDIRECT_STATUSES.has(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response; // Location 없는 3xx — 최종 응답으로 취급
    await response.body?.cancel().catch(() => {});
    if (hop >= MAX_REDIRECTS) throw httpError(400, 'SSRF guard: too many redirects');

    const nextUrl = new URL(location, currentUrl);
    currentUrl = await validateOutboundUrl(nextUrl.toString());
    const nextOrigin = originOf(currentUrl);
    if (nextOrigin !== currentOrigin) stripSensitiveHeaders(headers);
    currentOrigin = nextOrigin;
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== 'GET' && method !== 'HEAD')) {
      method = 'GET';
      body = undefined;
      delete headers['content-type'];
      delete headers['Content-Type'];
    }
    // 307/308은 메서드·본문 그대로 유지
  }
}
