/**
 * 마케팅이 쓰는 비밀(메일 공급자 키 · 결제 webhook 비밀)의 복호화 — 서버 안에서만, 쓰는 순간에만.
 *
 * outreach-credential.ts 와 같은 규칙이다: 전역(account_id NULL) 또는 캠페인과 같은 실행 키의 Credential 만 쓰고,
 * 아니면 던진다. 환경 변수로 대체하지 않는다. 반환값은 문자열 필드 전부다 — 어떤 필드가 필요한지는
 * 쓰는 쪽(메일 어댑터 · 결제 어댑터)이 안다. 이 값은 로그 · 감사 detail · 응답에 넣지 않는다.
 */
import type { Repository } from 'typeorm';
import { Credential } from '../../entities/Credential';
import { decryptStrict, keyedDigest } from '../../services/encryption.service';
import { canonicalJson } from '../../common/marketing/budget';
import {
  DIRECT_PAYMENT_PROVIDER_LABELS,
  type DirectPaymentProvider,
} from '../../common/marketing/payment-routes';
import { marketingError } from './marketing-errors';

export async function assertCredentialInAccount(
  credRepo: Repository<Credential>,
  credentialId: string,
  accountId: string,
): Promise<Credential> {
  const cred = credentialId ? await credRepo.findOne({ where: { id: credentialId } }) : null;
  if (!cred) throw marketingError(400, 'credential not found');
  if (cred.account_id !== null && cred.account_id !== accountId) {
    throw marketingError(400, 'credential belongs to a different account');
  }
  if (cred.agent_env) {
    // 에이전트 환경 변수로 나가는 credential 은 에이전트가 이미 값을 쥐고 있다 — 서버만 집행한다는
    // 원칙(docs/marketing.md "원칙" 1)이 무너지므로 받지 않는다.
    throw marketingError(400, 'this credential is exposed to agents (agent_env) — use a server-only credential for marketing');
  }
  return cred;
}

export async function resolveMarketingSecret(
  credRepo: Repository<Credential>,
  credentialId: string,
  accountId: string,
): Promise<Record<string, string>> {
  const cred = await assertCredentialInAccount(credRepo, credentialId, accountId);
  return decryptCredentialFields(cred);
}

/**
 * credential 내용의 지문(16 hex) — 복호화한 필드를 정규화 JSON 으로 만들어 암호화 키로 서명한다. 실행 계획에 넣어 두고 승인 · 실행 때
 * 대조한다: 승인 대기 중에 키를 다른 계정의 키로 바꾸면 그 요청은 실행되지 않는다. 이름 · 설명만 바꿔 다시 저장한 것은 그대로다.
 * 에이전트도 계획을 읽지만 키 없이는 지문에서 비밀 값을 알아낼 수 없다.
 */
export function credentialFingerprint(cred: Credential): string {
  return keyedDigest('marketing-payment-credential', `${cred.id}\n${canonicalJson(decryptCredentialFields(cred))}`).slice(0, 16);
}

function decryptCredentialFields(cred: Credential): Record<string, string> {
  let data: unknown;
  try {
    data = JSON.parse(decryptStrict(cred.encrypted_data));
  } catch {
    throw marketingError(409, 'credential is unreadable');
  }
  const out: Record<string, string> = {};
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim()) out[key] = value.trim();
    }
  }
  return out;
}

/**
 * 직접 결제 공급자(Meta Ads · Google Ads)의 credential — 돈이 움직이는 키라 조건이 더 좁다(docs/marketing.md "직접 결제 어댑터"):
 *   - 그 공급자 전용 credential(`provider` 칼럼이 공급자 이름)만 받는다. 다른 용도의 키를 잘못 고르는 일이 없다.
 *   - 이 계정의 credential 만. 전역 credential 은 설치 관리자의 것이라, 한 계정의 지출에 쓰면 소유 경계를 넘는다.
 *   - 에이전트 노출(agent_env)은 거부한다(assertCredentialInAccount).
 * 지문은 승인 · 실행 때 요청의 계획과 대조한다 — 그 사이 키를 바꾸면 그 요청은 실행되지 않는다.
 */
export async function resolveDirectPaymentCredential(
  credRepo: Repository<Credential>,
  provider: DirectPaymentProvider,
  credentialId: string,
  accountId: string,
): Promise<{ credential: Credential; fields: Record<string, string>; fingerprint: string }> {
  const credential = await assertCredentialInAccount(credRepo, credentialId, accountId);
  const label = DIRECT_PAYMENT_PROVIDER_LABELS[provider];
  if (credential.account_id === null) {
    throw marketingError(400, `a global credential cannot pay for one account — create the ${label} credential in this account`);
  }
  if (credential.provider !== provider) {
    throw marketingError(400, `credential "${credential.name}" is a ${credential.provider || 'custom'} credential — ${label} payments need a credential created with the ${label} provider`);
  }
  // 지문과 필드를 같은 행에서 — 두 번 읽으면 그 사이 바뀐 키가 옛 지문과 짝지어질 수 있다.
  const fields = decryptCredentialFields(credential);
  return { credential, fields, fingerprint: credentialFingerprint(credential) };
}
