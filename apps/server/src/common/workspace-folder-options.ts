import { z } from 'zod';

/**
 * Shared workspace-folder options for QA scenarios and security profiles.
 *
 * Both QaScenario and SecurityProfile carry an identical set of "where + how do
 * I run" knobs so a scenario/profile can pin the agent to a stable working
 * folder, an explicit repo, and a build strategy instead of letting each run
 * pick an arbitrary folder (the GameClient QA re-clone problem). The server is
 * the authority on whether a given run is COLD (full clean build) or WARM
 * (incremental/reuse) — `decideRunFreshness` makes that call from the stored
 * `build_mode` + `checkout_mode` + the per-scenario `last_built_commit` state,
 * so the agent never has to infer it. Ticket (3) renders the decision into the
 * run prompt; ticket (4) wires the agent-manager provisioner to it.
 *
 * The field set is deliberately duplicated on both entities (rather than a
 * shared embedded column) to keep the simple-json/scalar columns flat and
 * SQLite+Postgres-sync-safe (nullable / defaulted). This module owns the types,
 * the normalization, the deterministic-default folder resolver, and the
 * cold/warm decision so the two subsystems stay in lockstep.
 */

/** How the working folder is prepared before a run. */
export type CheckoutMode = 'reuse' | 'fresh';
/** Build strategy across runs. */
export type BuildMode = 'cold_then_warm' | 'always_cold' | 'always_warm';
/** Server-decided per-run build freshness — drives the rendered prompt. */
export type RunFreshness = 'cold' | 'warm';

/**
 * Where to get the repo for a run. When null, the run reuses the board /
 * workspace `environment_config` repo (the existing provisioning infra).
 *  - resource_id: a checked-in repo Resource id (preferred, carries auth).
 *  - url:         a raw git URL (escape hatch when there is no Resource).
 *  - branch:      branch/ref to check out; omitted = the repo's default.
 */
export interface WorkspaceFolderRepoRef {
  resource_id?: string;
  url?: string;
  branch?: string;
}

export const CHECKOUT_MODES: CheckoutMode[] = ['reuse', 'fresh'];
export const BUILD_MODES: BuildMode[] = ['cold_then_warm', 'always_cold', 'always_warm'];
export const DEFAULT_CHECKOUT_MODE: CheckoutMode = 'reuse';
export const DEFAULT_BUILD_MODE: BuildMode = 'cold_then_warm';

/**
 * Normalize a free-text `workspace_folder` into a clean relative path (or '').
 * Leading slashes are stripped so the value stays under the agent's home — it is
 * never allowed to be absolute. '' means "unset" → the deterministic default is
 * resolved at prompt-render time via `resolveWorkspaceFolder`.
 */
export function normalizeWorkspaceFolder(input: any): string {
  if (input == null) return '';
  return String(input).trim().replace(/^[/\\]+/, '');
}

export function normalizeCheckoutMode(input: any): CheckoutMode {
  return input === 'fresh' ? 'fresh' : 'reuse';
}

export function normalizeBuildMode(input: any): BuildMode {
  return BUILD_MODES.includes(input) ? input : DEFAULT_BUILD_MODE;
}

/**
 * Normalize the loose `repo_ref` input into a clean ref (or null). An object
 * with no usable key collapses to null — i.e. "inherit the board/workspace
 * environment_config repo".
 */
export function normalizeRepoRef(input: any): WorkspaceFolderRepoRef | null {
  if (input == null || typeof input !== 'object') return null;
  const out: WorkspaceFolderRepoRef = {};
  if (input.resource_id != null && String(input.resource_id).trim()) out.resource_id = String(input.resource_id).trim();
  if (input.url != null && String(input.url).trim()) out.url = String(input.url).trim();
  if (input.branch != null && String(input.branch).trim()) out.branch = String(input.branch).trim();
  return out.resource_id || out.url || out.branch ? out : null;
}

/**
 * Resolve the effective working folder: the explicit `workspace_folder` when
 * set, otherwise the deterministic id-based default `<kind>/<id>` (e.g.
 * `qa/<scenario_id>`, `security/<profile_id>`). Keeps the folder stable across
 * runs of the same scenario/profile so a warm build dir survives.
 */
export function resolveWorkspaceFolder(
  folder: string | null | undefined,
  kind: 'qa' | 'security',
  id: string,
): string {
  const explicit = normalizeWorkspaceFolder(folder);
  return explicit || `${kind}/${id}`;
}

export interface RunFreshnessInput {
  build_mode: BuildMode;
  checkout_mode: CheckoutMode;
  /** The most recent successfully-built commit, or null if never built. */
  last_built_commit: string | null;
}

/**
 * Server-authoritative COLD/WARM decision for an upcoming run. The agent does
 * NOT infer this — ticket (3) renders the result imperatively into the prompt.
 *
 *  - `fresh` checkout wipes the folder → always COLD.
 *  - `always_cold` / `always_warm` force the answer, ignoring state.
 *  - `cold_then_warm` (default): COLD until a build has been recorded
 *    (`last_built_commit` set), then WARM. The recorded commit is advanced by
 *    the provisioner (ticket 4) after a successful build.
 */
export function decideRunFreshness(input: RunFreshnessInput): RunFreshness {
  if (input.checkout_mode === 'fresh') return 'cold';
  if (input.build_mode === 'always_cold') return 'cold';
  if (input.build_mode === 'always_warm') return 'warm';
  return input.last_built_commit ? 'warm' : 'cold';
}

// ── Zod schema (reused by the QA + security MCP create/update tools) ──────────

export const repoRefSchema = z
  .object({
    resource_id: z.string().optional().describe('Checked-in repo Resource id (preferred)'),
    url: z.string().optional().describe('Raw git URL (escape hatch when there is no Resource)'),
    branch: z.string().optional().describe('Branch/ref to check out; omit for the repo default'),
  })
  .describe(
    'Repo to run against. Omit/null to reuse the board/workspace environment_config repo.',
  );

export const checkoutModeSchema = z
  .enum(['reuse', 'fresh'])
  .describe('How the working folder is prepared (default "reuse"; "fresh" wipes + re-checks-out → cold build).');

export const buildModeSchema = z
  .enum(['cold_then_warm', 'always_cold', 'always_warm'])
  .describe('Build strategy across runs (default "cold_then_warm": cold until first successful build, then warm).');
