import { z } from 'zod';

export const CLI_RUNTIME_NONE = 'none';
export const RESERVED_RUNTIME_ENV = new Set([
  'AWB_API_KEY', 'HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
]);

const ClaudeMappingSchema = z.object({
  env: z.record(z.string(), z.string()).optional(),
  args: z.array(z.string()).optional(),
}).strict().optional();

export const CliRuntimeProfileSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i, 'must be a stable profile id'),
  provider: z.string().min(1),
  type: z.string().min(1).default('server'),
  model: z.string().min(1),
  command: z.string().min(1).optional(),
  module: z.string().min(1).optional(),
  executable: z.string().min(1).optional(),
  python: z.string().min(1).optional(),
  venv: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  extra_args: z.array(z.string()).optional(),
  base_url: z.string().url().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  startup_timeout_ms: z.number().int().positive().max(600_000).default(120_000),
  health_check: z.string().min(1).default('/health'),
  shutdown_policy: z.enum(['on_release', 'manager_exit', 'reuse']).default('on_release'),
  credential_required: z.boolean().default(false),
  credential_ref: z.string().uuid().optional(),
  capabilities: z.array(z.string()).default([]),
  claude: ClaudeMappingSchema,
}).strict().superRefine((value, ctx) => {
  const launchCount = [value.command, value.module, value.executable].filter(Boolean).length;
  if (launchCount > 1) {
    ctx.addIssue({ code: 'custom', path: ['command'], message: 'set only one of command, module, or executable' });
  }
  if (value.shutdown_policy !== 'reuse' && launchCount === 0 && value.provider !== 'vllm') {
    ctx.addIssue({ code: 'custom', path: ['command'], message: 'a command, module, or executable is required' });
  }
  if (value.credential_required && !value.credential_ref) {
    ctx.addIssue({ code: 'custom', path: ['credential_ref'], message: 'is required when credential_required is true' });
  }
  for (const key of Object.keys({ ...(value.env ?? {}), ...(value.claude?.env ?? {}) })) {
    if (RESERVED_RUNTIME_ENV.has(key.toUpperCase())) {
      ctx.addIssue({ code: 'custom', path: ['env', key], message: `${key} is reserved and cannot be overridden` });
    }
  }
});

export const CliRuntimeProfilesSchema = z.array(CliRuntimeProfileSchema).superRefine((profiles, ctx) => {
  const seen = new Set<string>();
  profiles.forEach((profile, index) => {
    if (seen.has(profile.id)) ctx.addIssue({ code: 'custom', path: [index, 'id'], message: `duplicate profile id "${profile.id}"` });
    seen.add(profile.id);
  });
});

export type CliRuntimeProfile = z.infer<typeof CliRuntimeProfileSchema>;

export function validateCliRuntimeProfiles(raw: unknown):
  | { ok: true; value: CliRuntimeProfile[] }
  | { ok: false; error: string } {
  const parsed = CliRuntimeProfilesSchema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    error: `Invalid cli_runtime_profiles: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
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
  if (!profile) throw new Error(`CLI runtime profile "${selected.value}" selected by ${selected.source} does not exist`);
  return profile;
}
