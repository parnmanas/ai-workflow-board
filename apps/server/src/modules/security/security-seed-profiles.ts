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

/** ISO date the curated baseline below was authored (ticket e1f1bb99). Each item
 *  carries it as `added_at` so the baseline's provenance is explicit; the agent's
 *  `refresh_security_checklist` flow stamps newer items with their own time. */
const SEED_ADDED_AT = '2026-06-25T00:00:00.000Z';

/**
 * Curated baseline checklist for AWB's own codebase (ticket e1f1bb99 #knowledge).
 *
 * Every item is grounded in a real code hotspot in this repo (named in the
 * `guidance`) and backed by an OWASP/CWE `source` link, so a fresh inspection has
 * concrete things to look at on day one. The agent-driven
 * `refresh_security_checklist` flow keeps this current — it WebSearches the live
 * OWASP Top 10 + recent stack CVE/GHSA advisories and folds them in on top of
 * this baseline (preserving these items by id).
 *
 * Mapped hotspots (item → code):
 *   authn-session-tokens   → services/auth.service.ts (SALT_ROUNDS), common/guards/agent-auth.guard.ts, modules/mcp/mcp.controller.ts (MCP_API_KEYS)
 *   security-misconfig     → main.ts (MCP_DEV_MODE/AGENT_DEV_MODE bypass), db synchronize
 *   cors-config            → main.ts:49 enableCors / CORS_ORIGIN
 *   injection-sql          → any createQueryBuilder().where() in modules/**
 *   injection-command-git  → modules/mcp/shared/git-branches.ts (ls-remote `--` guard), git-repo-cache.ts
 *   ssrf-server-fetch      → modules/mcp/shared/git-repo-cache.ts clone, Resource-driven git/WebFetch
 *   xss-rendered-content   → apps/client markdown/dangerouslySetInnerHTML of ticket/comment/chat text
 *   input-validation       → MCP tool zod schemas, controller @Body() any checks
 *   secrets-in-code        → committed keys / connection strings
 *   secret-masking         → common/mask.ts maskSecret, log/response redaction
 *   crypto-weak            → bcryptjs hashing, crypto.randomUUID/randomBytes for tokens
 *   file-upload-limits     → common/constants/upload.ts (MAX_IMAGE_SIZE), resource-media.controller.ts (Range)
 *   deps-vulnerable        → package.json / lockfile changes
 *   sensitive-data-exposure→ entity rows returned without field projection
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
      'check. Flag endpoints that trust a client-supplied id without verifying workspace ownership ' +
      '(e.g. a *_id from the body used in a query with no workspace match).',
    source: 'https://owasp.org/Top10/A01_2021-Broken_Access_Control/',
    added_at: SEED_ADDED_AT,
  },
  {
    id: 'authn-session-tokens',
    title: 'Authentication / session & API-key handling',
    category: 'authz',
    severity_hint: 'high',
    guidance:
      'Password hashing goes through bcryptjs with SALT_ROUNDS (services/auth.service.ts) — never ' +
      'store/compare plaintext. Agent calls authenticate via AgentAuthGuard (X-Agent-Key) and MCP ' +
      'via MCP_API_KEYS; verify keys are validated and workspace-scoped. Flag any new route that ' +
      'skips the guard, and confirm dev bypasses (AGENT_DEV_MODE / MCP_DEV_MODE) cannot be reached ' +
      'in production.',
    source: 'https://owasp.org/Top10/A07_2021-Identification_and_Authentication_Failures/',
    added_at: SEED_ADDED_AT,
  },
  {
    id: 'injection-sql',
    title: 'SQL / query injection (TypeORM parameter binding)',
    category: 'injection',
    severity_hint: 'critical',
    guidance:
      'TypeORM queries must use parameter binding (`:param`), never string-concatenated user input ' +
      'into createQueryBuilder().where()/.andWhere() or raw SQL. Flag any interpolation of request ' +
      'values (ids, names, filters) into a query string.',
    source: 'https://cwe.mitre.org/data/definitions/89.html',
    added_at: SEED_ADDED_AT,
  },
  {
    id: 'injection-command-git',
    title: 'OS command / argument injection in git invocations',
    category: 'injection',
    severity_hint: 'high',
    guidance:
      'Server-side git runs (modules/mcp/shared/git-branches.ts, git-repo-cache.ts) take ' +
      'user-supplied repo URLs. They must use spawn/execFile with an argv array (never a shell ' +
      'string) AND a `--` end-of-options separator before the URL so a `--upload-pack=…`-style URL ' +
      "can't smuggle a flag (RCE). Flag any git call missing `--` or built via string concat.",
    source: 'https://cwe.mitre.org/data/definitions/88.html',
    added_at: SEED_ADDED_AT,
  },
  {
    id: 'ssrf-server-fetch',
    title: 'Server-Side Request Forgery via git clone / fetch',
    category: 'ssrf',
    severity_hint: 'high',
    guidance:
      'The server clones / ls-remotes arbitrary repo URLs from Resource records and may WebFetch ' +
      'URLs. An attacker-controlled URL can target internal services (169.254.169.254, localhost, ' +
      'private ranges) or non-git schemes (file://, ssh://). Flag fetch/clone of unvalidated URLs ' +
      'and missing scheme/host allowlisting.',
    source: 'https://owasp.org/Top10/A10_2021-Server-Side_Request_Forgery_%28SSRF%29/',
    added_at: SEED_ADDED_AT,
  },
  {
    id: 'xss-rendered-content',
    title: 'Stored / reflected XSS in rendered content',
    category: 'xss',
    severity_hint: 'high',
    guidance:
      'Ticket/comment/chat text is user-authored and rendered in the React client (markdown / ' +
      'mention tokens). Flag dangerouslySetInnerHTML or a markdown renderer used without ' +
      'sanitization on agent/user-controlled strings — script/img/onerror payloads must not execute.',
    source: 'https://cwe.mitre.org/data/definitions/79.html',
    added_at: SEED_ADDED_AT,
  },
  {
    id: 'input-validation',
    title: 'Missing / weak input validation',
    category: 'input-validation',
    severity_hint: 'medium',
    guidance:
      'Request bodies and MCP tool args should be validated (zod schema for MCP tools; explicit ' +
      'checks in controllers — many use `@Body() body: any`). Flag unbounded sizes, unchecked types ' +
      'feeding DB writes, and path/id values used without an existence + scope check.',
    source: 'https://owasp.org/www-project-proactive-controls/v3/en/c5-validate-inputs',
    added_at: SEED_ADDED_AT,
  },
  {
    id: 'secrets-in-code',
    title: 'Hardcoded secrets / credential leakage',
    category: 'secrets',
    severity_hint: 'critical',
    guidance:
      'No API keys, passwords, tokens, or connection strings committed in source. Secrets must come ' +
      'from env (process.env) or the Credential entity. Flag plaintext secrets and default/fallback ' +
      'credentials baked into code.',
    source: 'https://cwe.mitre.org/data/definitions/798.html',
    added_at: SEED_ADDED_AT,
  },
  {
    id: 'secret-masking',
    title: 'Secret masking in logs & responses',
    category: 'data-exposure',
    severity_hint: 'medium',
    guidance:
      'API keys, agent keys, and credential values must be masked (common/mask.ts `maskSecret`) ' +
      'anywhere they surface — log lines, error messages, and API responses. Flag a raw key/token ' +
      'logged or returned in full, and credential rows serialized without redaction.',
    source: 'https://cwe.mitre.org/data/definitions/532.html',
    added_at: SEED_ADDED_AT,
  },
  {
    id: 'crypto-weak',
    title: 'Weak or misused cryptography',
    category: 'crypto',
    severity_hint: 'high',
    guidance:
      'Password hashing must use bcrypt (bcryptjs, SALT_ROUNDS configured); no MD5/SHA1 for ' +
      'passwords, no custom crypto. Security tokens/ids must use crypto.randomUUID / randomBytes — ' +
      'flag Math.random() for anything security-relevant — and secret comparisons should be ' +
      'constant-time.',
    source: 'https://owasp.org/Top10/A02_2021-Cryptographic_Failures/',
    added_at: SEED_ADDED_AT,
  },
  {
    id: 'file-upload-limits',
    title: 'File upload size / type enforcement & streaming',
    category: 'config',
    severity_hint: 'medium',
    guidance:
      'Image/attachment uploads must enforce MAX_IMAGE_SIZE / MAX_TICKET_ATTACHMENT_SIZE and the ' +
      'ALLOWED_IMAGE_MIMETYPES allowlist (common/constants/upload.ts; chat-rooms.controller.ts). ' +
      'Raw media streaming (resource-media.controller.ts) must validate the Range header and scope ' +
      'the resource to the caller. Flag missing size/type checks (DoS / content smuggling).',
    source: 'https://cwe.mitre.org/data/definitions/434.html',
    added_at: SEED_ADDED_AT,
  },
  {
    id: 'cors-config',
    title: 'CORS configuration',
    category: 'config',
    severity_hint: 'medium',
    guidance:
      'enableCors (main.ts) reflects the request origin in dev (CORS_ORIGIN=true). In production ' +
      'CORS_ORIGIN must be an explicit origin allowlist — a wildcard/origin-reflection combined ' +
      'with credentials lets any site call the API as the user. Flag a permissive prod CORS policy.',
    source: 'https://owasp.org/Top10/A05_2021-Security_Misconfiguration/',
    added_at: SEED_ADDED_AT,
  },
  {
    id: 'security-misconfig',
    title: 'Security misconfiguration (dev bypasses / DB sync)',
    category: 'config',
    severity_hint: 'high',
    guidance:
      'Dev-only conveniences must not be reachable in prod: MCP_DEV_MODE / AGENT_DEV_MODE disable ' +
      'auth, and TypeORM synchronize=true auto-migrates schema (SQLite/dev only). Flag any of these ' +
      'gated on a flag that could be set in production, and default-on debug/verbose error output ' +
      'that leaks stack traces.',
    source: 'https://owasp.org/Top10/A05_2021-Security_Misconfiguration/',
    added_at: SEED_ADDED_AT,
  },
  {
    id: 'deps-vulnerable',
    title: 'Vulnerable / outdated dependencies',
    category: 'dependencies',
    severity_hint: 'medium',
    guidance:
      'Changes to package.json / lockfiles should not introduce known-vulnerable versions. Flag ' +
      'added dependencies with known CVEs/GHSAs or unmaintained packages in security-relevant ' +
      'paths (auth, crypto, parsing, the MCP SDK). The refresh flow folds in current advisories.',
    source: 'https://owasp.org/Top10/A06_2021-Vulnerable_and_Outdated_Components/',
    added_at: SEED_ADDED_AT,
  },
  {
    id: 'sensitive-data-exposure',
    title: 'Sensitive data exposure in responses',
    category: 'data-exposure',
    severity_hint: 'medium',
    guidance:
      'API responses must not leak password hashes, full credential rows, or other ' +
      "users'/workspaces' data. Flag entity rows returned without field projection (a *toJson* that " +
      'spreads the whole row) and cross-workspace data reachable without a scope check.',
    source: 'https://cwe.mitre.org/data/definitions/200.html',
    added_at: SEED_ADDED_AT,
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
