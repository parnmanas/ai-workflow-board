// ─── LLM CLI catalog (client mirror) ────────────────────────────────────────
// Every per-CLI fact the UI needs (label, credential prefix + providers, login
// flow, session/effort/model capabilities, runtime-config knobs, …) comes from
// ONE descriptor list instead of 14+ hand-maintained tables scattered across
// components. The server owns the truth (`GET /api/cli-catalog`, mirrored in
// `apps/server/src/common/cli-catalog.ts`); `STATIC_CLI_CATALOG` is the
// byte-identical literal used before the fetch lands, when the fetch fails,
// and in tests. `test/cli-catalog-contract.test.mjs` pins the two together.
//
// Rules for consumers:
//   - Never branch on a CLI id literal (`cli === 'hermes'`) in a component —
//     read the descriptor field that encodes the capability instead.
//   - Every helper below has a safe generic fallback for ids the catalog
//     doesn't know (custom / future CLIs / '' ), so callers never throw.
//   - Purely visual per-CLI data (brand colour, short code, fallback prose)
//     deliberately does NOT live here — see `./presentation.ts`.
import { useSyncExternalStore } from 'react';

export type CliTransport = 'cli' | 'acp' | 'none';
export type CliEffortKey = 'model' | 'effort' | 'ultracode';
export type CliCollaboration = 'single' | 'delegated' | 'swarm';

export interface CliCredentialProviderDescriptor {
  id: string;
  label: string;
  fields: string[];
  required: string[];
  multiline: string[];
  revealable: string[];
}

export interface CliLoginPreset {
  label: string;
  provider: string;
  method: string;
}

export interface CliLoginDescriptor {
  harvest_provider: string;
  harvest_field: string;
  provider_scoped: boolean;
  command: string;
  file_path: string | null;
  extra_file_field: string | null;
  presets: CliLoginPreset[];
}

export interface CliDescriptor {
  id: string;
  label: string;
  transport: CliTransport;
  executable: boolean;
  collaboration: CliCollaboration[];
  credential: { prefix: string; providers: CliCredentialProviderDescriptor[] } | null;
  login: CliLoginDescriptor | null;
  sessions: { acp: boolean; backend_profile: boolean };
  effort: { slice_key?: string; keys: CliEffortKey[] } | null;
  model_selectable: boolean;
  runtime_config: { profiles: boolean; child_limits: boolean };
  updatable: boolean;
}

/** The CLI a form starts on when nothing else picked one. */
export const DEFAULT_CLI_ID = 'claude';

const NO_RUNTIME_CONFIG = { profiles: false, child_limits: false } as const;
const MODEL_ONLY_EFFORT = { keys: ['model'] as CliEffortKey[] };

export const STATIC_CLI_CATALOG: CliDescriptor[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    transport: 'cli',
    executable: true,
    collaboration: ['single'],
    credential: {
      prefix: 'claude_',
      providers: [
        { id: 'claude_subscription', label: 'Claude (Subscription)', fields: ['credentials_json'], required: ['credentials_json'], multiline: ['credentials_json'], revealable: [] },
        { id: 'claude_api_key', label: 'Claude (API Key)', fields: ['api_key'], required: ['api_key'], multiline: [], revealable: [] },
        { id: 'claude_oauth_token', label: 'Claude (OAuth Token)', fields: ['oauth_token'], required: ['oauth_token'], multiline: [], revealable: ['oauth_token'] },
      ],
    },
    login: {
      harvest_provider: 'claude_subscription',
      harvest_field: 'credentials_json',
      provider_scoped: false,
      command: 'claude auth login',
      file_path: '~/.claude/.credentials.json',
      extra_file_field: null,
      presets: [],
    },
    sessions: { acp: true, backend_profile: true },
    effort: { keys: ['effort', 'ultracode', 'model'] },
    model_selectable: true,
    runtime_config: { ...NO_RUNTIME_CONFIG },
    updatable: true,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    transport: 'cli',
    executable: true,
    collaboration: ['single'],
    credential: {
      prefix: 'deepseek_',
      providers: [
        { id: 'deepseek_api_key', label: 'DeepSeek (API Key)', fields: ['api_key', 'model', 'base_url'], required: ['api_key'], multiline: [], revealable: [] },
      ],
    },
    login: null,
    sessions: { acp: false, backend_profile: false },
    effort: { slice_key: 'claude', keys: ['effort', 'ultracode', 'model'] },
    model_selectable: true,
    runtime_config: { ...NO_RUNTIME_CONFIG },
    updatable: true,
  },
  {
    id: 'codex',
    label: 'Codex',
    transport: 'cli',
    executable: true,
    collaboration: ['single'],
    credential: {
      prefix: 'codex_',
      providers: [
        { id: 'codex_subscription', label: 'Codex (Subscription)', fields: ['auth_json', 'config_toml'], required: ['auth_json'], multiline: ['auth_json', 'config_toml'], revealable: [] },
        { id: 'codex_api_key', label: 'Codex (API Key)', fields: ['api_key'], required: ['api_key'], multiline: [], revealable: [] },
      ],
    },
    login: {
      harvest_provider: 'codex_subscription',
      harvest_field: 'auth_json',
      provider_scoped: false,
      command: 'codex login --device-auth',
      file_path: '~/.codex/auth.json',
      extra_file_field: 'config_toml',
      presets: [],
    },
    sessions: { acp: true, backend_profile: false },
    effort: { ...MODEL_ONLY_EFFORT },
    model_selectable: true,
    runtime_config: { ...NO_RUNTIME_CONFIG },
    updatable: true,
  },
  {
    id: 'antigravity',
    label: 'Antigravity',
    transport: 'cli',
    executable: true,
    collaboration: ['single'],
    credential: {
      prefix: 'antigravity_',
      providers: [
        { id: 'antigravity_subscription', label: 'Antigravity (Subscription)', fields: ['oauth_creds_json'], required: ['oauth_creds_json'], multiline: ['oauth_creds_json'], revealable: [] },
        { id: 'antigravity_api_key', label: 'Antigravity (API Key)', fields: ['api_key'], required: ['api_key'], multiline: [], revealable: [] },
      ],
    },
    login: null,
    sessions: { acp: false, backend_profile: false },
    effort: { ...MODEL_ONLY_EFFORT },
    model_selectable: true,
    runtime_config: { ...NO_RUNTIME_CONFIG },
    updatable: true,
  },
  {
    id: 'pi',
    label: 'PI',
    transport: 'cli',
    executable: true,
    collaboration: ['single'],
    credential: null,
    login: null,
    sessions: { acp: false, backend_profile: false },
    effort: { ...MODEL_ONLY_EFFORT },
    model_selectable: true,
    runtime_config: { ...NO_RUNTIME_CONFIG },
    updatable: true,
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    transport: 'cli',
    executable: true,
    collaboration: ['single'],
    credential: {
      prefix: 'opencode_',
      providers: [
        { id: 'opencode_auth', label: 'Opencode (Provider Auth)', fields: ['auth_json'], required: ['auth_json'], multiline: ['auth_json'], revealable: [] },
        { id: 'opencode_api_key', label: 'Opencode Go (API Key)', fields: ['api_key'], required: ['api_key'], multiline: [], revealable: [] },
      ],
    },
    login: {
      harvest_provider: 'opencode_auth',
      harvest_field: 'auth_json',
      provider_scoped: true,
      command: 'opencode auth login -p <provider> -m "<method>"',
      file_path: '~/.local/share/opencode/auth.json',
      extra_file_field: null,
      presets: [
        { label: 'OpenAI — ChatGPT Pro/Plus', provider: 'openai', method: 'ChatGPT Pro/Plus (headless)' },
        { label: 'GitHub Copilot', provider: 'github-copilot', method: 'Login with GitHub Copilot' },
      ],
    },
    sessions: { acp: true, backend_profile: false },
    effort: { ...MODEL_ONLY_EFFORT },
    model_selectable: true,
    runtime_config: { ...NO_RUNTIME_CONFIG },
    updatable: true,
  },
  {
    id: 'hermes',
    label: 'Hermes ACP',
    transport: 'acp',
    executable: true,
    collaboration: ['single', 'delegated', 'swarm'],
    credential: null,
    login: null,
    sessions: { acp: true, backend_profile: false },
    effort: null,
    model_selectable: false,
    runtime_config: { profiles: true, child_limits: true },
    updatable: true,
  },
  {
    id: 'custom',
    label: 'Custom',
    transport: 'none',
    executable: false,
    collaboration: ['single'],
    credential: null,
    login: null,
    sessions: { acp: false, backend_profile: false },
    effort: null,
    model_selectable: true,
    runtime_config: { ...NO_RUNTIME_CONFIG },
    updatable: false,
  },
];

// ─── Store ──────────────────────────────────────────────────────────────────
// Module-level so plain helpers (`cliLabel`, …) stay synchronous and usable
// from non-React code (pure logic modules, tests). Components that must
// re-render once the fetched catalog replaces the static one subscribe via
// `useCliCatalog()`.

let current: CliDescriptor[] = STATIC_CLI_CATALOG;
const listeners = new Set<() => void>();
let loadPromise: Promise<CliDescriptor[]> | null = null;
let failureLogged = false;

export function cliCatalog(): CliDescriptor[] {
  return current;
}

export function setCliCatalog(list: CliDescriptor[]): void {
  current = list;
  for (const listener of listeners) listener();
}

export function subscribeCliCatalog(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Test hook — put the store back to the static mirror. */
export function resetCliCatalog(): void {
  loadPromise = null;
  failureLogged = false;
  setCliCatalog(STATIC_CLI_CATALOG);
}

function looksLikeCatalog(value: unknown): value is CliDescriptor[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((d) => d && typeof d === 'object' && typeof (d as CliDescriptor).id === 'string');
}

/**
 * Fetch the server catalog once per page load (call after the session is
 * established — the endpoint requires a logged-in user). On any failure the
 * static mirror stays in place and a single warning is logged; the UI keeps
 * working from the mirror.
 */
export function loadCliCatalog(): Promise<CliDescriptor[]> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      // Dynamic import keeps this module free of the api client at evaluation
      // time (pure-logic modules and tests import the catalog without it).
      const { api } = await import('../api');
      const result = await api.getCliCatalog();
      if (looksLikeCatalog(result?.clis)) setCliCatalog(result.clis);
      else throw new Error('malformed catalog payload');
    } catch (err) {
      if (!failureLogged) {
        failureLogged = true;
        console.warn(`[cli-catalog] using the static mirror — fetch failed: ${(err as Error)?.message ?? String(err)}`);
      }
      loadPromise = null;
    }
    return current;
  })();
  return loadPromise;
}

export function useCliCatalog(): CliDescriptor[] {
  return useSyncExternalStore(subscribeCliCatalog, cliCatalog, cliCatalog);
}

// ─── Helpers (all tolerate unknown ids) ─────────────────────────────────────

export function cliDescriptor(id: string | null | undefined): CliDescriptor | undefined {
  if (!id) return undefined;
  return current.find((d) => d.id === id);
}

/** Display label; the raw id when the catalog doesn't know it. */
export function cliLabel(id: string): string {
  return cliDescriptor(id)?.label ?? id;
}

export function cliCredentialPrefix(id: string | null | undefined): string | null {
  return cliDescriptor(id)?.credential?.prefix ?? null;
}

export function cliSupportsCredential(id: string | null | undefined): boolean {
  return cliCredentialPrefix(id) !== null;
}

export function cliSupportsBackendProfile(id: string | null | undefined): boolean {
  return cliDescriptor(id)?.sessions.backend_profile ?? false;
}

/** Unknown CLIs keep the free-text model input (the historic default). */
export function cliModelSelectable(id: string | null | undefined): boolean {
  return cliDescriptor(id)?.model_selectable ?? true;
}

export function cliEffortKeys(id: string | null | undefined): CliEffortKey[] {
  return cliDescriptor(id)?.effort?.keys ?? [];
}

export function cliLoginInfo(id: string | null | undefined): CliLoginDescriptor | null {
  return cliDescriptor(id)?.login ?? null;
}

export function cliRuntimeConfig(id: string | null | undefined): CliDescriptor['runtime_config'] {
  return cliDescriptor(id)?.runtime_config ?? NO_RUNTIME_CONFIG;
}

export function cliCollaboration(id: string | null | undefined): CliCollaboration[] {
  return cliDescriptor(id)?.collaboration ?? ['single'];
}

/** Unknown CLIs are assumed updatable (only the catalog can say otherwise). */
export function cliUpdatable(id: string | null | undefined): boolean {
  return cliDescriptor(id)?.updatable ?? true;
}

export interface FlattenedCredentialProvider extends CliCredentialProviderDescriptor {
  /** Owning CLI id. */
  cli: string;
}

/** Every CLI credential provider, flattened in catalog order (dropdowns). */
export function cliCredentialProviders(catalog: CliDescriptor[] = current): FlattenedCredentialProvider[] {
  const out: FlattenedCredentialProvider[] = [];
  for (const d of catalog) {
    for (const p of d.credential?.providers ?? []) out.push({ cli: d.id, ...p });
  }
  return out;
}

/** The CLI that owns a credential provider id (by prefix), if any. */
export function cliForCredentialProvider(providerId: string | null | undefined): CliDescriptor | undefined {
  if (!providerId) return undefined;
  return current.find((d) => d.credential && providerId.startsWith(d.credential.prefix));
}

export function loginCapableClis(catalog: CliDescriptor[] = current): CliDescriptor[] {
  return catalog.filter((d) => d.login !== null);
}

export function executableClis(catalog: CliDescriptor[] = current): CliDescriptor[] {
  return catalog.filter((d) => d.executable);
}

export function acpSessionClis(catalog: CliDescriptor[] = current): CliDescriptor[] {
  return catalog.filter((d) => d.sessions.acp);
}

export interface EffortEditorCli {
  id: string;
  label: string;
  keys: CliEffortKey[];
}

/**
 * CLIs that get their own block in the board effort-preset editor: those with
 * an effort slice of their own. A CLI that reads another CLI's slice
 * (`effort.slice_key`, e.g. deepseek → claude) is edited through that slice.
 */
export function effortEditorClis(catalog: CliDescriptor[] = current): EffortEditorCli[] {
  return catalog
    .filter((d) => d.effort !== null && !d.effort.slice_key)
    .map((d) => ({ id: d.id, label: d.label, keys: d.effort!.keys }));
}
