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
  cloudflare: { label: 'Cloudflare', fields: ['api_token'] },
  doola: { label: 'doola Partner', fields: ['api_key'] },
  mercury: { label: 'Mercury', fields: ['api_token'] },
  stripe: { label: 'Stripe', fields: ['secret_key'] },
  xero: { label: 'Xero', fields: ['access_token'] },
  chatwoot: { label: 'Chatwoot Cloud', fields: ['api_token'] },
  quickbooks: { label: 'QuickBooks Online', fields: ['access_token'] },
  intercom: { label: 'Intercom', fields: ['access_token'] },
  zendesk: { label: 'Zendesk Support OAuth', fields: ['access_token'] },
  freshdesk: { label: 'Freshdesk', fields: ['api_key'] },
  resend: { label: 'Resend', fields: ['api_key'] },
  resend_inbound: { label: 'Resend Receiving', fields: ['api_key', 'webhook_secret'] },
  microsoft_oauth: { label: 'Microsoft Graph OAuth', fields: ['client_id', 'client_secret'] },
  docusign_oauth: { label: 'DocuSign OAuth / Connect', fields: ['client_id', 'client_secret', 'hmac_secret'] },
  clio_oauth: { label: 'Clio Manage OAuth', fields: ['client_id', 'client_secret'] },
  uspto_tsdr: { label: 'USPTO TSDR', fields: ['api_key'] },
  openai: { label: 'OpenAI', fields: ['api_key'] },
  // OAuth 2.0 client from Google Cloud Console. refresh_token is optional but
  // an agent cannot call a Google API with the client pair alone — it needs a
  // token obtained once through the consent screen.
  google_oauth: { label: 'Google OAuth', fields: ['client_id', 'client_secret', 'refresh_token'] },
  // A git server reached over HTTPS that is not a project's own remote — e.g. a
  // self-hosted LFS store (`.lfsconfig` url). Exposed to agents it becomes a git
  // credential helper for that host, not just env (git-lfs never reads env).
  git_http: { label: 'Git (HTTPS host)', fields: ['url', 'username', 'token'] },
  // npm registry token (registry optional, default registry.npmjs.org). Exposed
  // to agents it authenticates their npm for that registry directly.
  npm: { label: 'npm registry', fields: ['token', 'registry'] },
  // `token` is the default key; the client lets the operator add more
  // key/value pairs (any field map is accepted on write).
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
