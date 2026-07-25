import { z } from 'zod';

export const CLI_RUNTIME_NONE = 'none';
export const RESERVED_RUNTIME_ENV = new Set([
  'AWB_API_KEY', 'HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
]);
export const SENSITIVE_RUNTIME_ENV = /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL)/i;

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

const ClaudeBackendProfileSchema = z.object({
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

export const CliRuntimeProfilesSchema = z.array(ClaudeBackendProfileSchema).superRefine((profiles, ctx) => {
  const seen = new Set<string>();
  profiles.forEach((profile, index) => {
    if (seen.has(profile.id)) ctx.addIssue({ code: 'custom', path: [index, 'id'], message: `duplicate profile id "${profile.id}"` });
    seen.add(profile.id);
  });
});

export type CliRuntimeProfile = z.infer<typeof ClaudeBackendProfileSchema>;

export function validateCliRuntimeProfiles(raw: unknown):
  | { ok: true; value: CliRuntimeProfile[] }
  | { ok: false; error: string } {
  const parsed = CliRuntimeProfilesSchema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    error: `Invalid Claude backend profiles: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
  };
}

export function parseCliRuntimeProfiles(raw: string | null | undefined): CliRuntimeProfile[] {
  if (!raw) return [];
  try {
    const parsed = CliRuntimeProfilesSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
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
