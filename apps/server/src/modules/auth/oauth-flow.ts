import { createHash, randomBytes } from 'crypto';

/**
 * Google 로그인 왕복의 서버 쪽 기억 — `state` 와 앱 교환 코드.
 *
 * 웹: start 가 무작위 state 를 내고 callback 이 그 state 를 확인한다(전에는 고정
 * 문자열이라 로그인 CSRF 를 막지 못했다).
 *
 * 앱: Google 은 WebView 안 로그인을 막으므로 앱은 시스템 브라우저(Custom Tab)로
 * 로그인하고 `awb://oauth?code=…` 로 돌아온다. 같은 스킴을 가로채는 다른 앱이
 * 세션을 훔치지 못하게 코드는 PKCE(S256)로 묶는다 — 앱만 아는 verifier 가 있어야
 * 코드를 세션 토큰으로 바꿀 수 있다(RFC 8252 · 7636).
 *
 * 메모리에만 둔다: 왕복은 몇 분이면 끝나고, 재시작으로 잃으면 다시 누르면 된다.
 */

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
export const APP_CODE_TTL_MS = 2 * 60 * 1000;
export const APP_REDIRECT = 'awb://oauth';

export type OAuthClient = { kind: 'web' } | { kind: 'app'; challenge: string };

const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

export function isValidCodeChallenge(v: unknown): v is string {
  return typeof v === 'string' && CHALLENGE_RE.test(v);
}

export function s256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export class OAuthFlowStore {
  private states = new Map<string, { client: OAuthClient; at: number }>();
  private codes = new Map<string, { token: string; challenge: string; at: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  issueState(client: OAuthClient): string {
    this.sweep();
    const state = randomBytes(24).toString('base64url');
    this.states.set(state, { client, at: this.now() });
    return state;
  }

  /** 한 번만 쓸 수 있다. 모르거나 만료된 state 면 null. */
  consumeState(state: unknown): OAuthClient | null {
    if (typeof state !== 'string' || !state) return null;
    const hit = this.states.get(state);
    if (!hit) return null;
    this.states.delete(state);
    if (this.now() - hit.at > OAUTH_STATE_TTL_MS) return null;
    return hit.client;
  }

  issueAppCode(token: string, challenge: string): string {
    this.sweep();
    const code = randomBytes(24).toString('base64url');
    this.codes.set(code, { token, challenge, at: this.now() });
    return code;
  }

  /** 코드 + verifier → 세션 토큰. 틀리면 코드도 버린다(재시도로 verifier 를 맞혀 볼 수 없게). */
  exchangeAppCode(code: unknown, verifier: unknown): string | null {
    if (typeof code !== 'string' || !code) return null;
    const hit = this.codes.get(code);
    if (!hit) return null;
    this.codes.delete(code);
    if (this.now() - hit.at > APP_CODE_TTL_MS) return null;
    if (typeof verifier !== 'string' || !VERIFIER_RE.test(verifier)) return null;
    if (s256(verifier) !== hit.challenge) return null;
    return hit.token;
  }

  private sweep() {
    const now = this.now();
    for (const [k, v] of this.states) if (now - v.at > OAUTH_STATE_TTL_MS) this.states.delete(k);
    for (const [k, v] of this.codes) if (now - v.at > APP_CODE_TTL_MS) this.codes.delete(k);
  }
}

export function appRedirect(params: Record<string, string>): string {
  return `${APP_REDIRECT}?${new URLSearchParams(params).toString()}`;
}
