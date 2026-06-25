import type { SecurityChecklistItem } from '../../entities/SecurityProfile';
import type { CreateProfileInput } from './security-profile.service';

/**
 * Seed catalogue of security-inspection profiles (ticket cfd74638).
 *
 * The security-inspection feature (SecurityProfile/SecurityRun) ships with an
 * empty catalogue — `list_security_profiles` returns []. This module is the
 * single source of truth for a starter set; it mirrors qa-seed-scenarios.ts.
 *
 * Each entry is **scope-agnostic data** (no workspace/agent/board ids baked in):
 * it carries the `checklist[]` rendered into the run prompt, a `scan_driver`, and
 * the `scope_mode`. buildProfileCreatePayloads() stamps the env-specific scope on
 * at seed time, so the catalogue is reproducible across environments.
 *
 * This foundation ticket ships ONE profile — a 'code-review' inspection of AWB's
 * own codebase with a baseline OWASP-Top-10 / input-validation / authz / secrets
 * checklist. The detailed, up-to-date checklist items are filled in by the
 * #knowledge follow-up ticket; this is the minimal seed that makes the feature
 * exercisable end-to-end (run → findings → complete → baseline advance).
 *
 * Consumed by:
 *   - scripts/seed-security-profiles.mjs (idempotent upsert into a live workspace)
 *
 * `target_resource_id` is omitted (null) so the inspection targets AWB's own
 * codebase (the agent's worktree).
 */

export interface SeedProfile {
  /** Stable key — used to match-and-update on re-seed (mapped to a tag `key:<key>`). */
  key: string;
  name: string;
  description: string;
  scan_driver: string;
  scan_driver_config: Record<string, any>;
  scope_mode: 'incremental' | 'full';
  tags: string[];
  checklist: SecurityChecklistItem[];
}

/** The driver the seeded profile uses: a code-review lens over the source tree. */
const CODE_REVIEW_DRIVER = 'code-review';

/**
 * Baseline checklist. Deliberately small + high-signal — #knowledge expands it
 * with current OWASP guidance and AWB-specific sensitive areas (MCP auth, guard
 * chain, TypeORM query building, Resource raw-stream paths).
 */
const BASELINE_CHECKLIST: SecurityChecklistItem[] = [
  {
    id: 'authz-broken-access-control',
    title: 'Broken access control / missing authorization',
    category: 'authz',
    severity_hint: 'high',
    guidance:
      'Every controller route and MCP tool that mutates or reads scoped data must go through the ' +
      'guard chain (AuthGuard/PermissionGuard/AgentAuthGuard) or an explicit workspace_id scope ' +
      'check. Flag endpoints that trust a client-supplied id without verifying workspace ownership.',
  },
  {
    id: 'injection-sql',
    title: 'SQL / query injection',
    category: 'injection',
    severity_hint: 'critical',
    guidance:
      'TypeORM queries must use parameter binding (`:param`), never string-concatenated user input ' +
      'into createQueryBuilder().where()/.andWhere() or raw SQL. Flag any interpolation of request ' +
      'values into a query string.',
  },
  {
    id: 'input-validation',
    title: 'Missing / weak input validation',
    category: 'input-validation',
    severity_hint: 'medium',
    guidance:
      'Request bodies and MCP tool args should be validated (zod schema for MCP tools; explicit ' +
      'checks in controllers). Flag unbounded sizes, unchecked types feeding DB writes, and ' +
      'path/id values used without an existence + scope check.',
  },
  {
    id: 'secrets-in-code',
    title: 'Hardcoded secrets / credential leakage',
    category: 'secrets',
    severity_hint: 'critical',
    guidance:
      'No API keys, passwords, tokens, or connection strings committed in source or logged. ' +
      'Secrets must come from env (process.env) or the Credential entity. Flag plaintext secrets, ' +
      'and secrets echoed into logs or error messages.',
  },
  {
    id: 'crypto-weak',
    title: 'Weak or misused cryptography',
    category: 'crypto',
    severity_hint: 'high',
    guidance:
      'Password hashing must use bcrypt (bcryptjs, SALT_ROUNDS configured); no MD5/SHA1 for ' +
      'passwords, no custom crypto. Flag predictable tokens (Math.random for security tokens — use ' +
      'crypto.randomUUID/randomBytes) and missing constant-time comparison for secret checks.',
  },
  {
    id: 'deps-vulnerable',
    title: 'Vulnerable / outdated dependencies',
    category: 'dependencies',
    severity_hint: 'medium',
    guidance:
      'Changes to package.json / lockfiles should not introduce known-vulnerable versions. Flag ' +
      'added dependencies with known CVEs or unmaintained packages in security-relevant paths ' +
      '(auth, crypto, parsing).',
  },
  {
    id: 'sensitive-data-exposure',
    title: 'Sensitive data exposure in responses/logs',
    category: 'data-exposure',
    severity_hint: 'medium',
    guidance:
      'API responses and logs must not leak password hashes, full credential rows, or other ' +
      "users'/workspaces' data. Flag entity rows returned without field projection and logs that " +
      'dump request bodies containing secrets.',
  },
];

export const SECURITY_SEED_PROFILES: SeedProfile[] = [
  {
    key: 'awb-self-code-review',
    name: 'AWB self code-review (OWASP baseline)',
    description:
      'Incremental security inspection of AWB\'s own codebase. On each run the agent reviews the ' +
      'changes since the last passing inspection (or the whole tree on the first run / when a ' +
      'change touches a security-sensitive area) against the baseline checklist below, recording ' +
      'findings with severities. A PASS advances the incremental baseline.',
    scan_driver: CODE_REVIEW_DRIVER,
    scan_driver_config: {
      // Where the agent should focus the review. Advisory — the agent still runs
      // git itself in its worktree to compute the actual diff.
      include_globs: ['apps/server/src/**', 'apps/agent-manager/src/**', 'apps/client/src/**'],
      sensitive_paths: [
        'apps/server/src/common/guards/**',
        'apps/server/src/modules/auth/**',
        'apps/server/src/modules/mcp/**',
        'apps/server/src/services/api-key.service.ts',
        'apps/server/src/entities/Credential.ts',
      ],
    },
    scope_mode: 'incremental',
    tags: ['owasp', 'code-review', 'self-inspection'],
    checklist: BASELINE_CHECKLIST,
  },
];

export interface BuildProfileOptions {
  workspace_id: string;
  target_agent_id: string;
  /** null/'' → workspace-scoped; <uuid> → pinned to that board. */
  board_id?: string | null;
  /** <uuid> → inspect that repo Resource; omit → AWB's own codebase. */
  target_resource_id?: string | null;
  created_by?: string;
  /** Only seed profiles whose `key` is in this list (default: all). */
  only?: string[];
}

/** Tag a profile carries so re-seeds can find their prior row by stable key. */
export function keyTag(key: string): string {
  return `key:${key}`;
}

/**
 * Stamp the env-specific scope (workspace/board/agent) onto each template and
 * return ready-to-create payloads. The stable `key` is preserved both as the
 * leading tag (`key:<key>`) and on `_key`, so an idempotent seeder can
 * match-and-update instead of duplicating.
 */
export function buildProfileCreatePayloads(opts: BuildProfileOptions): Array<CreateProfileInput & { _key: string }> {
  const wanted = opts.only && opts.only.length ? new Set(opts.only) : null;
  return SECURITY_SEED_PROFILES.filter((p) => !wanted || wanted.has(p.key)).map((p) => ({
    _key: p.key,
    workspace_id: opts.workspace_id,
    board_id: opts.board_id ?? null,
    name: p.name,
    description: p.description,
    checklist: p.checklist,
    target_agent_id: opts.target_agent_id,
    target_resource_id: opts.target_resource_id ?? null,
    scan_driver: p.scan_driver,
    scan_driver_config: p.scan_driver_config,
    scope_mode: p.scope_mode,
    enabled: true,
    tags: [keyTag(p.key), ...p.tags],
    created_by: opts.created_by ?? '',
    max_runs: 20,
  }));
}
