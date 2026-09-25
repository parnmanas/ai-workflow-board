// ─── Per-CLI presentation (UI-only) ─────────────────────────────────────────
// Things the server catalog deliberately does not carry because they are
// pure client presentation: brand colour, 2-letter short code, credential
// provider icon letters, and the "credential left empty" fallback prose.
// Facts (labels, prefixes, capabilities) come from `./catalog.ts`; this table
// only decorates them. Unknown ids get neutral defaults — never throw.
import { tokens } from '../tokens';
import { cliForCredentialProvider, loginCapableClis } from './catalog';

export interface CliPresentation {
  /** Brand colour used for icons / badges. */
  color: string;
  /** Two-letter short code for compact icons. */
  code: string;
}

const NEUTRAL_COLOR = tokens.colors.textSecondary;

export const CLI_PRESENTATION: Record<string, CliPresentation> = {
  claude: { color: '#cc785c', code: 'CL' },
  deepseek: { color: '#4d6bfe', code: 'DS' },
  codex: { color: '#10a37f', code: 'CX' },
  antigravity: { color: '#4285f4', code: 'AG' },
  pi: { color: NEUTRAL_COLOR, code: 'PI' },
  opencode: { color: '#fbbf24', code: 'OC' },
  hermes: { color: NEUTRAL_COLOR, code: 'HM' },
  custom: { color: NEUTRAL_COLOR, code: 'CU' },
};

/** Non-CLI credential providers (git hosts, generic API keys) — colours only;
 *  their labels/fields live next to the credential form that renders them. */
const NON_CLI_PROVIDER_COLORS: Record<string, string> = {
  github: '#24292f',
  gitlab: '#fc6d26',
  openai: '#10a37f',
  custom: NEUTRAL_COLOR,
};

/** Icon letters for CLI credential providers (kept verbatim from the old
 *  hand-written PROVIDERS table so existing rows keep their look). */
const CLI_PROVIDER_ICONS: Record<string, string> = {
  claude_subscription: 'CS',
  claude_api_key: 'CK',
  claude_oauth_token: 'CO',
  deepseek_api_key: 'DS',
  codex_subscription: 'OS',
  codex_api_key: 'OK',
  antigravity_subscription: 'AS',
  antigravity_api_key: 'AK',
  opencode_auth: 'OA',
};

export function cliPresentation(cliId: string | null | undefined): CliPresentation {
  return (cliId && CLI_PRESENTATION[cliId]) || { color: NEUTRAL_COLOR, code: (cliId || '??').slice(0, 2).toUpperCase() };
}

export function cliColor(cliId: string | null | undefined): string {
  return cliPresentation(cliId).color;
}

export function providerColor(providerId: string | null | undefined): string {
  if (!providerId) return NEUTRAL_COLOR;
  const owner = cliForCredentialProvider(providerId);
  if (owner) return cliColor(owner.id);
  return NON_CLI_PROVIDER_COLORS[providerId] ?? NEUTRAL_COLOR;
}

/** Icon letters for a CLI credential provider; falls back to the owning CLI's
 *  short code, then a plain 'C'. */
export function providerIcon(providerId: string | null | undefined): string {
  if (!providerId) return 'C';
  if (CLI_PROVIDER_ICONS[providerId]) return CLI_PROVIDER_ICONS[providerId];
  const owner = cliForCredentialProvider(providerId);
  return owner ? cliPresentation(owner.id).code : 'C';
}

/** Which login-capable CLI the login / import dialogs open on. A UI
 *  preference (codex has the smoothest device-auth flow), not a catalog fact;
 *  degrades to the first login-capable CLI if codex ever stops being one. */
export const PREFERRED_LOGIN_CLI = 'codex';
export function defaultLoginCli(): string {
  const capable = loginCapableClis();
  return capable.some((d) => d.id === PREFERRED_LOGIN_CLI)
    ? PREFERRED_LOGIN_CLI
    : (capable[0]?.id ?? '');
}

// ─── Credential-empty fallback prose ────────────────────────────────────────
// What "no per-agent credential" means per adapter. The runtime source of
// truth is agent-manager's per-CLI `prepareCliHome`:
//   - claude      → host ~/.claude/.credentials.json (`claude login`) symlink/copy
//   - codex       → host ~/.codex/auth.json (`codex login`) symlink/copy
//   - deepseek    → host shell env DEEPSEEK_API_KEY (+ optional BASE_URL/MODEL), no login file
//   - antigravity → host shell env GEMINI_API_KEY / GOOGLE_API_KEY, no login file
//   - pi          → host ~/.pi/agent/{auth.json,settings.json} (`pi /login`) symlink/copy;
//                   AWB has no per-agent credential concept for it at all (ticket d72282ad)
//   - opencode    → a bound `opencode_auth` credential is injected as
//                   `OPENCODE_AUTH_CONTENT` (wins over the file); when unbound the host
//                   ~/.local/share/opencode/auth.json (`opencode auth login`) is symlinked
// Change the adapter → change the prose here too. Consumed through
// `utils/credentialFallback.ts`, which stays the public API.

export interface CredentialFallbackCopy {
  /** Label of the empty "None" option in the credential <select>. */
  optionLabel: string;
  /**
   * One-sentence help below the field. States first that an empty value is
   * a valid host-fallback configuration (not an auth failure), and then that
   * it does not by itself guarantee auth availability (the host file/env
   * must actually exist).
   */
  meaning: string;
}

export const CREDENTIAL_FALLBACK_COPY: Record<string, CredentialFallbackCopy> = {
  claude: {
    optionLabel: 'None — use the host Claude CLI login (claude login)',
    meaning:
      'Leaving this empty is a valid fallback configuration, not a per-agent credential gap: the manager points this agent at the host Claude CLI login — the claude login credential at ~/.claude/.credentials.json (a.k.a. "operator HOME") on the manager host — on every spawn. Authentication still requires that host login to actually exist; if it is absent the adapter injects no auth and turns fail.',
  },
  codex: {
    optionLabel: 'None — use the host Codex CLI login (codex login)',
    meaning:
      'Leaving this empty is a valid fallback configuration, not a per-agent credential gap: the manager points this agent at the host Codex CLI login — the codex login credential at ~/.codex/auth.json (a.k.a. "operator HOME") on the manager host — on every spawn. Authentication still requires that host login to actually exist; if it is absent the adapter injects no auth and turns fail.',
  },
  deepseek: {
    optionLabel: 'None — use the host DEEPSEEK_API_KEY env',
    meaning:
      'Leaving this empty is a valid fallback configuration, not a per-agent credential gap: the manager falls back to the DEEPSEEK_API_KEY (and optional DEEPSEEK_BASE_URL / DEEPSEEK_MODEL) shell environment on the manager host on every spawn. Authentication still requires DEEPSEEK_API_KEY to actually be set in that environment; if it is unset no key is injected and turns fail.',
  },
  antigravity: {
    optionLabel: 'None — use the host GEMINI_API_KEY env',
    meaning:
      'Leaving this empty is a valid fallback configuration, not a per-agent credential gap: the manager falls back to the GEMINI_API_KEY / GOOGLE_API_KEY shell environment on the manager host on every spawn. Authentication still requires that env var to actually be set on the host; if it is unset no key is injected and turns fail.',
  },
  pi: {
    optionLabel: 'None — pi has no per-agent credential (uses the host pi login)',
    meaning:
      'Leaving this empty is a valid fallback configuration, not a per-agent credential gap: pi has no per-agent credential concept at all, so the manager always points this agent at the host pi login — the config at ~/.pi/agent/{auth.json,settings.json} (a.k.a. "operator HOME") on the manager host, set up via `pi /login` (including a credential-free local llama.cpp server) — on every spawn. Authentication still requires that host login to actually exist; if it is absent pi surfaces its own login error and turns fail.',
  },
  opencode: {
    optionLabel: 'None — use the host opencode login (opencode auth login)',
    meaning:
      'Leaving this empty is a valid fallback configuration, not a per-agent credential gap: the manager points this agent at the host opencode login — the auth at ~/.local/share/opencode/auth.json (a.k.a. "operator HOME") on the manager host, set up via `opencode auth login` — on every spawn. Pick an opencode_auth credential instead to give this agent its own account (it is injected as OPENCODE_AUTH_CONTENT and takes precedence over that file, which stays untouched). Authentication still requires the host login to actually exist when nothing is picked; if it is absent opencode surfaces its own login error and turns fail.',
  },
};

/** Generic prose for unknown / custom CLIs — asserts no adapter specifics. */
export const GENERIC_CREDENTIAL_FALLBACK: CredentialFallbackCopy = {
  optionLabel: 'None — use the operator login on the manager host',
  meaning:
    'Leaving this empty is a valid fallback configuration, not a per-agent credential gap: the manager falls back to the operator login stored on the manager host ("operator HOME") on every spawn. Authentication still requires that host credential to actually exist.',
};
