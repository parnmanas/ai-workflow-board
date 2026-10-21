/**
 * 마케팅이 쓰는 비밀(메일 공급자 키 · 결제 webhook 비밀)의 복호화 — 서버 안에서만, 쓰는 순간에만.
 *
 * outreach-credential.ts 와 같은 규칙이다: 전역(account_id NULL) 또는 캠페인과 같은 실행 키의 Credential 만 쓰고,
 * 아니면 던진다. 환경 변수로 대체하지 않는다. 반환값은 문자열 필드 전부다 — 어떤 필드가 필요한지는
 * 쓰는 쪽(메일 어댑터 · 결제 어댑터)이 안다. 이 값은 로그 · 감사 detail · 응답에 넣지 않는다.
 */
import type { Repository } from 'typeorm';
import { Credential } from '../../entities/Credential';
import { decryptStrict } from '../../services/encryption.service';
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
