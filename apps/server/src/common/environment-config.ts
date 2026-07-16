import { z } from 'zod';

/**
 * Board / Workspace environment setup configuration (ticket 354d336b).
 *
 * Describes the working environment an agent needs BEFORE it starts a ticket on
 * a board: git repositories to clone/prepare under the agent home, non-secret
 * env vars to inject into the subagent, and bootstrap commands to run once.
 * Stored as a JSON text column on both Workspace (`environment_config` =
 * workspace-wide default) and Board (`environment_config` = per-board override),
 * mirroring the `Board.harness_config` / `Board.effort_presets` convention.
 *
 * Resolution is KEY-LEVEL (resolveEnvironmentConfig): a board only overrides the
 * top-level keys it sets; unset keys fall through to the workspace default. Both
 * unset → null, which every consumer must treat as "no environment setup —
 * dispatch exactly as before" (null-safe contract, same as harness_config).
 *
 * The resolved config (with each repository's `resource_id` already expanded to
 * a concrete url/branch server-side) is shipped on the agent_trigger SSE
 * payload; agent-manager provisions the environment just before spawning the
 * subagent — clone/update repos, run setup commands, inject env_vars — and
 * writes a per-(agent,board) fingerprint marker so the next dispatch skips a
 * fully-prepared environment.
 *
 * SCOPE DECISIONS (Plan was auto-advanced; finalized here, see ticket handoff):
 *   - The existing operator-configured `working_dir` / worktree flow is left
 *     UNCHANGED. Environment provisioning is ADDITIVE — repos land under the
 *     agent home (target_dir is relative to it), never repurposing working_dir.
 *   - Only non-secret env vars live here; secrets keep using the existing
 *     per-agent credential path. env_vars is intentionally string→string.
 *   - Node/runtime/system-package version pinning is NOT modelled as dedicated
 *     keys — express it via setup_commands (e.g. `nvm use 20`) so we don't ship
 *     a half-supported field. `version` is a free integer the operator bumps to
 *     force re-provisioning even when nothing else changed (folded into the
 *     fingerprint).
 */

/** A relative path is required for target_dir — reject absolute / parent escapes. */
const RelativePathSchema = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/') && !p.startsWith('~') && !/^[A-Za-z]:[\\/]/.test(p), {
    message: 'must be a relative path (no leading / or ~ or drive letter)',
  })
  .refine((p) => !p.split(/[\\/]/).some((seg) => seg === '..'), {
    message: 'must not contain ".." path segments',
  });

export const EnvironmentRepositorySchema = z
  .object({
    /** Repository Resource id (type='repository'). Server expands it to a concrete
     *  url/default_branch at resolve time. Either resource_id or url is required. */
    resource_id: z.string().optional(),
    /** Direct clone url when no resource_id is given (or to override the resource). */
    url: z.string().optional(),
    /** Where to place the clone, RELATIVE to the agent home. Defaults to
     *  `repos/<derived-name>` when omitted. */
    target_dir: RelativePathSchema.optional(),
    /** Branch to checkout. Falls back to the resource's default_branch, then origin/HEAD. */
    branch: z.string().optional(),
    /** Commands run ONCE inside this repo's directory right after a fresh clone
     *  (not re-run on fetch/pull of an existing clone). */
    post_clone_commands: z.array(z.string()).optional(),
  })
  .strict()
  .refine((r) => (r.resource_id && r.resource_id.trim()) || (r.url && r.url.trim()), {
    message: 'each repository needs a resource_id or a url',
  });

export const EnvironmentConfigSchema = z
  .object({
    /** Repositories to clone/prepare under the agent home. */
    repositories: z.array(EnvironmentRepositorySchema).optional(),
    /** Non-secret env vars injected into the subagent process. string→string. */
    env_vars: z.record(z.string(), z.string()).optional(),
    /** Bootstrap commands run once (in the agent home) after repos are placed. */
    setup_commands: z.array(z.string()).optional(),
    /** Per-command timeout budget for clone + setup steps. 1..3600s, default 600. */
    setup_timeout_seconds: z.number().int().min(1).max(3600).optional(),
    /** Operator-bumped marker to force re-provisioning. Folded into the fingerprint. */
    version: z.number().int().min(0).optional(),
  })
  .strict();

export type EnvironmentRepository = z.infer<typeof EnvironmentRepositorySchema>;
export type EnvironmentConfig = z.infer<typeof EnvironmentConfigSchema>;

/**
 * WRITE-path schema (ticket 8fbe90e9). Board Settings > Environment Setup is now
 * a repository-Resource picker only — the single field an operator sets is each
 * repository's `resource_id`. Everything the old surface carried is either
 * derived from the Resource + server defaults (url / branch / target_dir), never
 * executed by agent-manager (setup_commands / post_clone_commands /
 * setup_timeout_seconds are parsed but never run — "checkout is exclusively owned
 * by WT/QA provisioning"), or non-essential process-only config (env_vars /
 * version). So the write contract accepts ONLY repositories[].resource_id.
 *
 * Unknown keys are STRIPPED, not rejected (zod object default): a not-yet-reloaded
 * client bundle or a legacy MCP caller that still POSTs the full shape during a
 * deploy window is NORMALISED to the repo-only shape rather than 400'd. The
 * STORED/READ schema (EnvironmentConfigSchema above) stays permissive so configs
 * already saved with the legacy keys keep resolving + executing unchanged — this
 * asymmetry (write-narrow, read-wide) is the backward-compat contract.
 */
const EnvironmentRepositoryInputSchema = z.object({
  resource_id: z.string().trim().min(1, 'each repository needs a resource_id'),
});

export const EnvironmentConfigInputSchema = z.object({
  repositories: z.array(EnvironmentRepositoryInputSchema).optional(),
});

/** A repository entry after server-side resolution: url is always concrete. */
export interface ResolvedEnvironmentRepository {
  resource_id: string;
  url: string;
  target_dir: string;
  branch: string;
  post_clone_commands: string[];
}

/** The fully-resolved config shipped on the agent_trigger SSE payload. */
export interface ResolvedEnvironmentConfig {
  repositories: ResolvedEnvironmentRepository[];
  env_vars: Record<string, string>;
  setup_commands: string[];
  setup_timeout_seconds: number;
  version: number;
}

export const ENVIRONMENT_CONFIG_KEYS = [
  'repositories',
  'env_vars',
  'setup_commands',
  'setup_timeout_seconds',
  'version',
] as const;

export const DEFAULT_SETUP_TIMEOUT_SECONDS = 600;

function isEmptyEnvironment(value: EnvironmentConfig): boolean {
  const hasRepos = Array.isArray(value.repositories) && value.repositories.length > 0;
  const hasEnv = value.env_vars && Object.keys(value.env_vars).length > 0;
  const hasSetup = Array.isArray(value.setup_commands) && value.setup_commands.length > 0;
  // setup_timeout_seconds / version alone are meaningless without something to provision.
  return !hasRepos && !hasEnv && !hasSetup;
}

/**
 * Parse a stored environment_config text column. Returns null for null/empty/
 * malformed/schema-violating input — a corrupt row must degrade to "no
 * environment setup", never throw on a read path (mirrors parseHarnessConfig).
 */
export function parseEnvironmentConfig(raw: string | null | undefined): EnvironmentConfig | null {
  if (!raw) return null;
  try {
    const parsed = EnvironmentConfigSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    return isEmptyEnvironment(parsed.data) ? null : parsed.data;
  } catch {
    return null;
  }
}

/**
 * Validate write-path input (REST PATCH body / MCP tool arg). Normalises to the
 * repository-Resource-only shape (EnvironmentConfigInputSchema): the returned
 * value carries at most `repositories: [{ resource_id }]` — every legacy key is
 * dropped. A repository entry missing a non-empty resource_id is REJECTED so the
 * caller can 400 (a genuinely malformed write, not a removed-field carry-over).
 */
export function validateEnvironmentConfigInput(
  input: unknown,
): { ok: true; value: EnvironmentConfig } | { ok: false; error: string } {
  const parsed = EnvironmentConfigInputSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, error: `Invalid environment_config: ${issues}` };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Serialize for storage: empty configs collapse to null (column stays null →
 * "no environment setup" stays representable as the single falsy state).
 */
export function serializeEnvironmentConfig(
  value: EnvironmentConfig | null | undefined,
): string | null {
  if (!value || isEmptyEnvironment(value)) return null;
  return JSON.stringify(value);
}

/**
 * Key-level merge of the workspace default with the board override. The board
 * wins per top-level key it explicitly sets; keys it leaves unset inherit from
 * the workspace. Both null → null (caller keeps current behaviour). Shared
 * resolve point for REST/MCP consumers and the dispatch path so every reader
 * agrees on precedence (mirrors resolveHarnessConfig).
 */
export function mergeEnvironmentConfig(
  workspaceRaw: string | null | undefined,
  boardRaw: string | null | undefined,
): EnvironmentConfig | null {
  const ws = parseEnvironmentConfig(workspaceRaw);
  const board = parseEnvironmentConfig(boardRaw);
  if (!ws) return board;
  if (!board) return ws;
  const merged: EnvironmentConfig = { ...ws };
  for (const key of ENVIRONMENT_CONFIG_KEYS) {
    if (board[key] !== undefined) (merged as any)[key] = board[key];
  }
  return isEmptyEnvironment(merged) ? null : merged;
}

/** Derive a target dir name from a clone url, e.g. ".../ai-workflow-board.git" → "ai-workflow-board". */
export function deriveRepoDirName(url: string): string {
  const last = (url || '').split(/[\\/]/).filter(Boolean).pop() || 'repo';
  return last.replace(/\.git$/i, '') || 'repo';
}

/**
 * Resolve a merged EnvironmentConfig into the concrete form shipped on the SSE
 * payload. `repoLookup` expands a repository's resource_id into { url,
 * default_branch } (the dispatch path passes a workspace-scoped Resource
 * lookup). A repository whose resource_id can't be resolved AND has no direct
 * url is dropped (logged by the caller) rather than shipping an un-cloneable
 * entry. Returns null when nothing actionable remains.
 */
export function resolveEnvironmentConfig(
  config: EnvironmentConfig | null,
  repoLookup: (resourceId: string) => { url: string; default_branch: string } | null,
): ResolvedEnvironmentConfig | null {
  if (!config) return null;
  const repositories: ResolvedEnvironmentRepository[] = [];
  for (const repo of config.repositories || []) {
    let url = (repo.url || '').trim();
    let defaultBranch = '';
    if (!url && repo.resource_id) {
      const looked = repoLookup(repo.resource_id.trim());
      if (looked) {
        url = (looked.url || '').trim();
        defaultBranch = (looked.default_branch || '').trim();
      }
    } else if (url && repo.resource_id) {
      // Direct url overrides, but still take the resource's default_branch as a fallback.
      const looked = repoLookup(repo.resource_id.trim());
      if (looked) defaultBranch = (looked.default_branch || '').trim();
    }
    if (!url) continue; // un-cloneable — caller logs the drop
    const branch = (repo.branch || '').trim() || defaultBranch || '';
    const targetDir = (repo.target_dir || '').trim() || `repos/${deriveRepoDirName(url)}`;
    repositories.push({
      resource_id: (repo.resource_id || '').trim(),
      url,
      target_dir: targetDir,
      branch,
      post_clone_commands: (repo.post_clone_commands || []).filter((c) => c && c.trim()),
    });
  }
  const envVars = config.env_vars || {};
  const setupCommands = (config.setup_commands || []).filter((c) => c && c.trim());
  if (repositories.length === 0 && Object.keys(envVars).length === 0 && setupCommands.length === 0) {
    return null;
  }
  return {
    repositories,
    env_vars: envVars,
    setup_commands: setupCommands,
    setup_timeout_seconds: config.setup_timeout_seconds || DEFAULT_SETUP_TIMEOUT_SECONDS,
    version: config.version ?? 0,
  };
}
