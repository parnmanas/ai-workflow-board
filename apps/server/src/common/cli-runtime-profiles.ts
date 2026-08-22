import { z } from 'zod';

export const CLI_RUNTIME_NONE = 'none';
export const RESERVED_RUNTIME_ENV = new Set([
  'AWB_API_KEY', 'HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
]);
export const SENSITIVE_RUNTIME_ENV = /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL)/i;

// ticket 7d8ea7c9 후속(리뷰 지적, P1) — apps/agent-manager/src/lib/runtime-profiles.ts
// 의 DEFAULT_SAFETY_MARGIN_TOKENS/MIN_OUTPUT_TOKENS 와 반드시 같은 값으로
// 유지할 것. context_window 가 (생략 시 기본값으로 간주하는) safety_margin_tokens
// 조차 감당 못 하면 agent-manager 의 resolveEffectiveMaxOutputTokens() 는
// known input 0(가장 유리한 경우)에서조차 항상 실패하므로, 그런 profile은
// 저장 시점에 명확히 거부한다.
const DEFAULT_SAFETY_MARGIN_TOKENS = 40_000;
const MIN_OUTPUT_TOKENS = 1_024;

const PublicEnvSchema = z.record(z.string(), z.string()).optional();
const LifecycleSchema = z.enum(['on_release', 'manager_exit', 'reuse']).default('on_release');

const AdapterSchema = z.object({
  command: z.string().min(1).optional(),
  module: z.string().min(1).optional(),
  executable: z.string().min(1).optional(),
  python: z.string().min(1).optional(),
  venv: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  env: PublicEnvSchema,
  args: z.array(z.string()).optional(),
  base_url: z.string().url(),
  startup_timeout_ms: z.number().int().positive().max(600_000).default(120_000),
  health_check: z.string().min(1).default('/health'),
  lifecycle: LifecycleSchema,
}).strict().superRefine((value, ctx) => {
  const launchCount = [value.command, value.module, value.executable].filter(Boolean).length;
  if (launchCount > 1) {
    ctx.addIssue({ code: 'custom', path: ['command'], message: 'set only one of command, module, or executable' });
  }
  if (value.lifecycle !== 'reuse' && launchCount === 0) {
    ctx.addIssue({ code: 'custom', path: ['command'], message: 'is required unless lifecycle is "reuse"' });
  }
});

export const ClaudeBackendProfileSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i, 'must be a stable profile id'),
  kind: z.literal('claude-backend').default('claude-backend'),
  protocol: z.enum(['anthropic-compatible', 'openai-compatible']),
  base_url: z.string().url(),
  model: z.string().min(1),
  claude_executable: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  env: PublicEnvSchema,
  args: z.array(z.string()).optional(),
  credential_required: z.boolean().default(false),
  credential_ref: z.string().uuid().optional(),
  auth_env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).default('ANTHROPIC_AUTH_TOKEN'),
  // ticket 7d8ea7c9 후속 — 백엔드 모델의 실제 context window 를 agent-manager
  // 에 알려 CLAUDE_CODE_MAX_CONTEXT_TOKENS/CLAUDE_CODE_MAX_OUTPUT_TOKENS 로
  // 주입하기 위한 필드. 셋 다 생략 가능(기존 프로필은 그대로 동작).
  context_window: z.number().int().positive().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  safety_margin_tokens: z.number().int().nonnegative().optional(),
  adapter: AdapterSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.protocol === 'openai-compatible' && !value.adapter) {
    ctx.addIssue({ code: 'custom', path: ['adapter'], message: 'is required for an OpenAI-compatible backend' });
  }
  if (value.protocol === 'anthropic-compatible' && value.adapter) {
    ctx.addIssue({ code: 'custom', path: ['adapter'], message: 'must be omitted for an Anthropic-compatible backend' });
  }
  if (value.credential_required && !value.credential_ref) {
    ctx.addIssue({ code: 'custom', path: ['credential_ref'], message: 'is required when credential_required is true' });
  }
  if (
    value.context_window !== undefined &&
    value.max_output_tokens !== undefined &&
    value.max_output_tokens >= value.context_window
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['max_output_tokens'],
      message: 'must be less than context_window',
    });
  }
  if (value.context_window !== undefined) {
    const effectiveMargin = value.safety_margin_tokens ?? DEFAULT_SAFETY_MARGIN_TOKENS;
    if (value.context_window - effectiveMargin < MIN_OUTPUT_TOKENS) {
      ctx.addIssue({
        code: 'custom',
        path: ['context_window'],
        message:
          `context_window minus safety_margin_tokens (${effectiveMargin}` +
          `${value.safety_margin_tokens === undefined ? ', default' : ''}) leaves less than ` +
          `${MIN_OUTPUT_TOKENS} tokens for output even for an empty prompt`,
      });
    }
  }
  for (const [scope, env] of [['env', value.env], ['adapter.env', value.adapter?.env]] as const) {
    for (const key of Object.keys(env ?? {})) {
      if (RESERVED_RUNTIME_ENV.has(key.toUpperCase())) {
        ctx.addIssue({ code: 'custom', path: [scope, key], message: `${key} is reserved and cannot be overridden` });
      }
      if (SENSITIVE_RUNTIME_ENV.test(key)) {
        ctx.addIssue({
          code: 'custom',
          path: [scope, key],
          message: `${key} is sensitive; use credential_ref and auth_env instead of a plaintext value`,
        });
      }
    }
  }
});

const LegacyCliRuntimeProfileSchema = z.object({
  id: z.string(),
  provider: z.string(),
  type: z.string().optional(),
  model: z.string(),
  command: z.string().optional(),
  module: z.string().optional(),
  executable: z.string().optional(),
  python: z.string().optional(),
  venv: z.string().optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  extra_args: z.array(z.string()).optional(),
  base_url: z.string().optional(),
  port: z.number().optional(),
  startup_timeout_ms: z.number().optional(),
  health_check: z.string().optional(),
  shutdown_policy: z.string().optional(),
  credential_required: z.boolean().optional(),
  credential_ref: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  claude: z.object({
    env: z.record(z.string(), z.string()).optional(),
    args: z.array(z.string()).optional(),
  }).strict().optional(),
}).strict();

function migrateLegacyProfile(raw: unknown, index: number): unknown {
  if (!raw || typeof raw !== 'object' || !('provider' in raw) || 'kind' in raw) return raw;
  const parsed = LegacyCliRuntimeProfileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `legacy profile at index ${index} is invalid: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const legacy = parsed.data;
  const provider = legacy.provider.trim().toLowerCase();
  const launchesBackend = Boolean(
    legacy.command || legacy.module || legacy.executable || legacy.python ||
    legacy.venv || legacy.port || legacy.extra_args?.length,
  );
  if (!['anthropic', 'anthropic-compatible', 'claude'].includes(provider) || launchesBackend) {
    throw new Error(
      `legacy profile "${legacy.id}" (provider: ${legacy.provider}) cannot be migrated safely because it ` +
      'represents a backend runtime. Replace it with kind "claude-backend": use protocol ' +
      '"anthropic-compatible" for a direct endpoint, or protocol "openai-compatible" with a declared adapter; ' +
      'AWB no longer starts the backend server itself',
    );
  }
  if (!legacy.base_url) {
    throw new Error(
      `legacy profile "${legacy.id}" cannot be migrated safely without base_url; add an endpoint and convert it to kind "claude-backend"`,
    );
  }
  return {
    id: legacy.id,
    kind: 'claude-backend',
    protocol: 'anthropic-compatible',
    base_url: legacy.base_url,
    model: legacy.model,
    ...(legacy.claude?.env ? { env: legacy.claude.env } : {}),
    ...(legacy.claude?.args ? { args: legacy.claude.args } : {}),
    credential_required: legacy.credential_required,
    ...(legacy.credential_ref ? { credential_ref: legacy.credential_ref } : {}),
    auth_env: 'ANTHROPIC_AUTH_TOKEN',
  };
}

function normalizeProfiles(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.map(migrateLegacyProfile);
}

export const CliRuntimeProfilesSchema = z.array(ClaudeBackendProfileSchema).superRefine((profiles, ctx) => {
  const seen = new Set<string>();
  profiles.forEach((profile, index) => {
    if (seen.has(profile.id)) ctx.addIssue({ code: 'custom', path: [index, 'id'], message: `duplicate profile id "${profile.id}"` });
    seen.add(profile.id);
  });
});

export type CliRuntimeProfile = z.infer<typeof ClaudeBackendProfileSchema>;

/** API/storage DTOs are rebuilt from this allow-list, never spread from input. */
export function sanitizeCliRuntimeProfile(profile: CliRuntimeProfile): CliRuntimeProfile {
  return ClaudeBackendProfileSchema.parse(profile);
}

export function validateCliRuntimeProfiles(raw: unknown):
  | { ok: true; value: CliRuntimeProfile[] }
  | { ok: false; error: string } {
  let normalized: unknown;
  try {
    normalized = normalizeProfiles(raw);
  } catch (error) {
    return { ok: false, error: `Invalid Claude backend profiles: ${(error as Error).message}` };
  }
  const parsed = CliRuntimeProfilesSchema.safeParse(normalized);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    error: `Invalid Claude backend profiles: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
  };
}

export function parseCliRuntimeProfiles(raw: string | null | undefined): CliRuntimeProfile[] {
  if (!raw) return [];
  try {
    const checked = validateCliRuntimeProfiles(JSON.parse(raw));
    if (!checked.ok) throw new Error(checked.error);
    return checked.value;
  } catch (error) {
    throw new Error(
      error instanceof SyntaxError
        ? `Invalid Claude backend profiles JSON: ${error.message}`
        : (error as Error).message,
    );
  }
}

export function resolveCliRuntimeProfile(
  profiles: CliRuntimeProfile[],
  selections: Array<{ source: string; value: string | null | undefined }>,
): CliRuntimeProfile | null {
  const selected = selections.find(({ value }) => value !== null && value !== undefined);
  if (!selected || selected.value === CLI_RUNTIME_NONE || selected.value === '') return null;
  const profile = profiles.find(item => item.id === selected.value);
  if (!profile) throw new Error(`Claude backend profile "${selected.value}" selected by ${selected.source} does not exist`);
  return profile;
}
