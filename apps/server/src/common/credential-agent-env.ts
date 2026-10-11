/**
 * Credential → agent environment variables.
 *
 * A non-CLI credential (Google OAuth client, GitHub token, a Custom key/value
 * set) can be opted in with `Credential.agent_env`. Every agent run whose
 * execution account can read the credential (its own account, or any account
 * for a global one) then gets each stored field as an env var on the spawned
 * CLI process: `<env_prefix>_<FIELD>` — `GOOGLE` + `client_id` →
 * `GOOGLE_CLIENT_ID`. An empty prefix uses the field name alone, which is
 * what a Custom credential whose keys are already env names wants.
 *
 * The manager fetches the resolved map at spawn time
 * (`GET /api/agent-manager/agent-env`) — the values never ride an SSE payload.
 *
 * CLI login credentials (claude_* / codex_* / …) are excluded: they are
 * applied through CLI settings into a per-agent cli-home, and dumping a
 * `.credentials.json` blob into env would only leak it wider.
 */
import { NON_CLI_CREDENTIAL_PROVIDERS } from './credential-providers';

const ENV_PREFIX_RE = /^[A-Z][A-Z0-9_]*$/;

/** Names the manager sets itself or that change how the child process loads. */
const BLOCKED_ENV_NAMES = new Set([
  'PATH', 'HOME', 'USERPROFILE', 'NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH',
  // CLI direct-key auth the adapters strip from the operator env (antigravity, opencode).
  'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY',
]);

/** AWB's own variables and the CLIs' login / endpoint variables. An exposed
 *  credential must not silently re-point which account or backend a CLI uses.
 *  The manager re-checks against each adapter's authEnvKeys() at spawn time;
 *  this list exists so the operator hears about it when saving, not later. */
const BLOCKED_ENV_PREFIXES = ['AWB_', 'ANTHROPIC_', 'CLAUDE_', 'CODEX_', 'OPENAI_', 'OPENCODE_', 'GEMINI_', 'DYLD_'];

/** Suggested prefix per provider — the client pre-fills it, nothing derives from it. */
export const DEFAULT_AGENT_ENV_PREFIX: Readonly<Record<string, string>> = {
  google_oauth: 'GOOGLE',
  github: 'GITHUB',
  gitlab: 'GITLAB',
};

export function agentEnvSupported(provider: string): boolean {
  return Object.prototype.hasOwnProperty.call(NON_CLI_CREDENTIAL_PROVIDERS, provider);
}

export function normalizeAgentEnvPrefix(raw: unknown): string {
  return String(raw ?? '').trim().toUpperCase().replace(/_+$/, '');
}

/** `client_id` → `CLIENT_ID`; anything outside [A-Z0-9_] becomes `_`. */
export function agentEnvName(prefix: string, field: string): string {
  const key = String(field).trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  return prefix ? `${prefix}_${key}` : key;
}

export function agentEnvNameProblem(name: string): string | null {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) return `${name || '(empty)'} is not a valid environment variable name`;
  if (BLOCKED_ENV_NAMES.has(name) || BLOCKED_ENV_PREFIXES.some((p) => name.startsWith(p))) {
    return `${name} is reserved for AWB or a CLI's own login/endpoint`;
  }
  return null;
}

/** Env var names for a credential's field keys (values are never needed). */
export function agentEnvNames(prefix: string, fieldKeys: readonly string[]): string[] {
  return fieldKeys.map((k) => agentEnvName(prefix, k));
}

/**
 * Write-time check for `agent_env: true`. Returns the first problem, or null.
 * `fieldKeys` are the keys that will be stored after the write.
 */
export function validateAgentEnvConfig(provider: string, prefix: string, fieldKeys: readonly string[]): string | null {
  if (!agentEnvSupported(provider)) {
    return `${provider} credentials are CLI logins — bind them in CLI settings instead of exposing them as environment variables`;
  }
  if (prefix && !ENV_PREFIX_RE.test(prefix)) {
    return `env prefix ${prefix} must start with a letter and use only A-Z, 0-9 and _`;
  }
  if (fieldKeys.length === 0) return 'credential has no fields to expose';
  const seen = new Map<string, string>();
  for (const field of fieldKeys) {
    const name = agentEnvName(prefix, field);
    const problem = agentEnvNameProblem(name);
    if (problem) return problem;
    const other = seen.get(name);
    if (other !== undefined) return `fields ${other} and ${field} both become ${name}`;
    seen.set(name, field);
  }
  return null;
}

export interface AgentEnvSource {
  id: string;
  name: string;
  provider: string;
  account_id: string | null;
  env_prefix: string;
  fields: Record<string, unknown>;
}

export interface ResolvedAgentEnv {
  env: Record<string, string>;
  sources: Array<{ credential_id: string; name: string; scope: 'global' | 'account'; env_names: string[] }>;
  skipped: Array<{ credential_id: string; name: string; reason: string }>;
}

/**
 * Merge every exposed credential an account can read into one env map.
 * Account credentials shadow global ones for the same variable (the same rule
 * Skills use for slugs); within one scope the first by name wins and the
 * loser is reported — never silently dropped.
 */
export function resolveAgentEnv(sources: readonly AgentEnvSource[]): ResolvedAgentEnv {
  const out: ResolvedAgentEnv = { env: {}, sources: [], skipped: [] };
  const owner = new Map<string, { scope: 'global' | 'account'; name: string }>();
  const ordered = [...sources].sort((a, b) => {
    const rank = (s: AgentEnvSource) => (s.account_id === null ? 1 : 0);
    return rank(a) - rank(b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });
  for (const src of ordered) {
    const scope: 'global' | 'account' = src.account_id === null ? 'global' : 'account';
    if (!agentEnvSupported(src.provider)) {
      out.skipped.push({ credential_id: src.id, name: src.name, reason: `${src.provider} cannot be exposed as env` });
      continue;
    }
    const names: string[] = [];
    for (const [field, value] of Object.entries(src.fields)) {
      if (typeof value !== 'string' || !value) continue;
      const envName = agentEnvName(src.env_prefix, field);
      const problem = agentEnvNameProblem(envName);
      if (problem) {
        out.skipped.push({ credential_id: src.id, name: src.name, reason: problem });
        continue;
      }
      const taken = owner.get(envName);
      if (taken) {
        if (!(taken.scope === 'account' && scope === 'global')) {
          out.skipped.push({ credential_id: src.id, name: src.name, reason: `${envName} is already set by ${taken.name}` });
        }
        continue;
      }
      owner.set(envName, { scope, name: src.name });
      out.env[envName] = value;
      names.push(envName);
    }
    if (names.length) out.sources.push({ credential_id: src.id, name: src.name, scope, env_names: names });
  }
  return out;
}
