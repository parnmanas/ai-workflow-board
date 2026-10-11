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
 * `git_http` is the exception to "fields become env": git and git-lfs only
 * authenticate through credential helpers, so an exposed git host is returned
 * as `git_credentials` (origin + username + token) and the manager turns it into
 * a helper for that host. It also gets env vars only when a prefix is set.
 * `npm` works the same way: returned as `npm_registries` (registry + token)
 * and installed as npm's own per-registry `_authToken` config.
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
  'USER', 'USERNAME', 'LOGNAME',
  // Re-point git itself; GIT_CONFIG_* is also how the manager installs git hosts.
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_ASKPASS',
  // CLI direct-key auth the adapters strip from the operator env (antigravity, opencode).
  'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY',
]);

/** AWB's own variables and the CLIs' login / endpoint variables. An exposed
 *  credential must not silently re-point which account or backend a CLI uses.
 *  The manager re-checks against each adapter's authEnvKeys() at spawn time;
 *  this list exists so the operator hears about it when saving, not later. */
const BLOCKED_ENV_PREFIXES = ['AWB_', 'ANTHROPIC_', 'CLAUDE_', 'CODEX_', 'OPENAI_', 'OPENCODE_', 'GEMINI_', 'DYLD_', 'GIT_CONFIG_'];

const GIT_HOST_PROVIDER = 'git_http';
const NPM_PROVIDER = 'npm';
/** Providers the manager delivers natively (git helper / npm auth config). */
const NATIVE_DELIVERY_PROVIDERS = new Set([GIT_HOST_PROVIDER, NPM_PROVIDER]);
export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org/';

/** Suggested prefix per provider — the client pre-fills it, nothing derives from it. */
export const DEFAULT_AGENT_ENV_PREFIX: Readonly<Record<string, string>> = {
  google_oauth: 'GOOGLE',
  github: 'GITHUB',
  gitlab: 'GITLAB',
  npm: 'NPM',
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

/** A natively delivered credential (git host, npm registry) emits env vars
 *  only when given a prefix — its bare field names (URL, USERNAME, TOKEN)
 *  would be meaningless or collide. */
function emitsEnv(provider: string, prefix: string): boolean {
  return !NATIVE_DELIVERY_PROVIDERS.has(provider) || !!prefix;
}

/** Registry URL npm keys auth by, always ending in `/`; null if not http(s).
 *  Empty means the public registry. */
export function npmRegistryUrl(raw: unknown): string | null {
  const text = String(raw ?? '').trim() || DEFAULT_NPM_REGISTRY;
  try {
    const url = new URL(text);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname) return null;
    url.search = '';
    url.hash = '';
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url.toString();
  } catch {
    return null;
  }
}

/** Env var names a credential produces (values are never needed). */
export function agentEnvNames(provider: string, prefix: string, fieldKeys: readonly string[]): string[] {
  return emitsEnv(provider, prefix) ? fieldKeys.map((k) => agentEnvName(prefix, k)) : [];
}

/** `https://lfs.example.com/org/repo.git/info/lfs` → `https://lfs.example.com`;
 *  null for anything that is not an http(s) URL with a host. git matches
 *  `credential.<url>.*` by host, so the origin is the whole key. */
export function gitHostOrigin(raw: unknown): string | null {
  try {
    const url = new URL(String(raw ?? '').trim());
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function presentKeys(fields: Record<string, unknown>): string[] {
  return Object.keys(fields).filter((k) => typeof fields[k] === 'string' && fields[k] !== '');
}

/**
 * Write-time check for `agent_env: true`. Returns the first problem, or null.
 * `fields` is the field map that will be stored after the write.
 */
export function validateAgentEnvConfig(provider: string, prefix: string, fields: Record<string, unknown>): string | null {
  if (!agentEnvSupported(provider)) {
    return `${provider} credentials are CLI logins — bind them in CLI settings instead of exposing them as environment variables`;
  }
  if (prefix && !ENV_PREFIX_RE.test(prefix)) {
    return `env prefix ${prefix} must start with a letter and use only A-Z, 0-9 and _`;
  }
  const fieldKeys = presentKeys(fields);
  if (fieldKeys.length === 0) return 'credential has no fields to expose';
  if (provider === GIT_HOST_PROVIDER) {
    if (!gitHostOrigin(fields.url)) return 'url must be an http(s) URL such as https://git.example.com';
    if (!fields.username || !fields.token) return 'a git host needs both username and token';
  }
  if (provider === NPM_PROVIDER) {
    if (!fields.token) return 'an npm registry credential needs a token';
    if (!npmRegistryUrl(fields.registry)) return 'registry must be an http(s) URL such as https://registry.npmjs.org/';
  }
  if (!emitsEnv(provider, prefix)) return null;
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
  /** Exposed git hosts — the manager installs a credential helper per origin. */
  git_credentials: Array<{ credential_id: string; name: string; url: string; username: string; password: string }>;
  /** Exposed npm registries — the manager sets npm's per-registry _authToken. */
  npm_registries: Array<{ credential_id: string; name: string; registry: string; token: string }>;
  sources: Array<{ credential_id: string; name: string; scope: 'global' | 'account'; env_names: string[]; git_host?: string; npm_registry?: string }>;
  skipped: Array<{ credential_id: string; name: string; reason: string }>;
}

/**
 * Merge every exposed credential an account can read into one env map.
 * Account credentials shadow global ones for the same variable (the same rule
 * Skills use for slugs); within one scope the first by name wins and the
 * loser is reported — never silently dropped.
 */
export function resolveAgentEnv(sources: readonly AgentEnvSource[]): ResolvedAgentEnv {
  const out: ResolvedAgentEnv = { env: {}, git_credentials: [], npm_registries: [], sources: [], skipped: [] };
  const owner = new Map<string, { scope: 'global' | 'account'; name: string }>();
  const gitOwner = new Map<string, { scope: 'global' | 'account'; name: string }>();
  const npmOwner = new Map<string, { scope: 'global' | 'account'; name: string }>();
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
    let gitHost: string | undefined;
    if (src.provider === GIT_HOST_PROVIDER) {
      const origin = gitHostOrigin(src.fields.url);
      const username = typeof src.fields.username === 'string' ? src.fields.username : '';
      const password = typeof src.fields.token === 'string' ? src.fields.token : '';
      const taken = origin ? gitOwner.get(origin) : undefined;
      if (!origin || !username || !password) {
        out.skipped.push({ credential_id: src.id, name: src.name, reason: 'git host needs an http(s) url, username and token' });
      } else if (taken) {
        if (!(taken.scope === 'account' && scope === 'global')) {
          out.skipped.push({ credential_id: src.id, name: src.name, reason: `git host ${origin} is already set by ${taken.name}` });
        }
      } else {
        gitOwner.set(origin, { scope, name: src.name });
        out.git_credentials.push({ credential_id: src.id, name: src.name, url: origin, username, password });
        gitHost = origin;
      }
    }
    let npmRegistry: string | undefined;
    if (src.provider === NPM_PROVIDER) {
      const registry = npmRegistryUrl(src.fields.registry);
      const token = typeof src.fields.token === 'string' ? src.fields.token : '';
      const taken = registry ? npmOwner.get(registry) : undefined;
      if (!registry || !token) {
        out.skipped.push({ credential_id: src.id, name: src.name, reason: 'npm registry needs a token and an http(s) registry URL' });
      } else if (taken) {
        if (!(taken.scope === 'account' && scope === 'global')) {
          out.skipped.push({ credential_id: src.id, name: src.name, reason: `npm registry ${registry} is already set by ${taken.name}` });
        }
      } else {
        npmOwner.set(registry, { scope, name: src.name });
        out.npm_registries.push({ credential_id: src.id, name: src.name, registry, token });
        npmRegistry = registry;
      }
    }
    const names: string[] = [];
    for (const [field, value] of Object.entries(emitsEnv(src.provider, src.env_prefix) ? src.fields : {})) {
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
    if (names.length || gitHost || npmRegistry) {
      out.sources.push({
        credential_id: src.id,
        name: src.name,
        scope,
        env_names: names,
        ...(gitHost ? { git_host: gitHost } : {}),
        ...(npmRegistry ? { npm_registry: npmRegistry } : {}),
      });
    }
  }
  return out;
}
