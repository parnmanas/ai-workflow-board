/**
 * Credential.provider 표 — `GET /api/credentials/providers` 가 그대로 돌려 주는
 * `{ [provider]: { label, fields } }` shape.
 *
 * CLI 쪽 provider(claude_* / codex_* / …)는 cli-catalog.ts 에서 파생된다. 여기
 * 손으로 유지하는 것은 **CLI 가 아닌** provider(저장소 토큰 등)뿐이다.
 */
import { CLI_CATALOG, catalogCredentialProviders, type CliDescriptor } from './cli-catalog';

export interface CredentialProviderFields {
  label: string;
  fields: string[];
}

/** CLI 가 아닌 credential provider — 카탈로그 밖에서 유일하게 손으로 유지하는 표. */
export const NON_CLI_CREDENTIAL_PROVIDERS: Readonly<Record<string, CredentialProviderFields>> = {
  github: { label: 'GitHub', fields: ['token'] },
  gitlab: { label: 'GitLab', fields: ['token'] },
  openai: { label: 'OpenAI', fields: ['api_key'] },
  custom: { label: 'Custom', fields: ['token'] },
};

/** 비-CLI 표 + 카탈로그 provider (카탈로그 순서). */
export function buildProviderFields(
  catalog: readonly CliDescriptor[] = CLI_CATALOG,
): Record<string, CredentialProviderFields> {
  const out: Record<string, CredentialProviderFields> = {};
  for (const [id, entry] of Object.entries(NON_CLI_CREDENTIAL_PROVIDERS)) {
    out[id] = { label: entry.label, fields: [...entry.fields] };
  }
  for (const p of catalogCredentialProviders(catalog)) {
    out[p.id] = { label: p.label, fields: [...p.fields] };
  }
  return out;
}

/** provider → admin 이 원문을 다시 볼 수 있는 필드(없으면 키 자체가 없다). */
export function buildRevealableFields(
  catalog: readonly CliDescriptor[] = CLI_CATALOG,
): Readonly<Record<string, readonly string[]>> {
  const out: Record<string, readonly string[]> = {};
  for (const p of catalogCredentialProviders(catalog)) {
    if (p.revealable.length > 0) out[p.id] = p.revealable;
  }
  return out;
}

export const PROVIDER_FIELDS: Readonly<Record<string, CredentialProviderFields>> = buildProviderFields();
export const REVEALABLE_OAUTH_FIELDS: Readonly<Record<string, readonly string[]>> = buildRevealableFields();
