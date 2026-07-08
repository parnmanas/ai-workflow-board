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
 * Fixed root (relative to the agent's working_dir) for every QA/security run
 * folder: `.awb/qa` (worktree 규약 ③). Mirrors the worktree convention's
 * `.awb/wt` root (규약 ②) so every agent-created scratch folder lives inside
 * `<working_dir>/.awb/` — never scattered under the manager home or the repo
 * tree. A resolved run folder is `<working_dir>/.awb/qa/<leaf>`; the
 * agent-manager provisioner joins it onto the agent's working_dir (which the
 * server never knows), and the run prompt names the same relative path.
 */
export const RUN_WORKSPACE_ROOT = '.awb/qa';

/**
 * The in-prompt shell token for a run's working folder. The agent-manager
 * provisioner pins the run subagent's cwd to the resolved folder BEFORE spawn
 * (규약 ③), so every command in a run prompt operates on the current directory.
 * Exported so the build-artifact-registry block (qa-prompt) points at the exact
 * same place as the working-folder block — keeping the two in lockstep.
 */
export const RUN_WORKSPACE_PROMPT_PATH = '.';

/**
 * Normalize a free-text `workspace_folder` into a clean relative path (or '').
 * Leading slashes are stripped so the value stays under the agent's home — it is
 * never allowed to be absolute. '' means "unset" → the deterministic default is
 * resolved at prompt-render time via `resolveWorkspaceFolder`.
 *
 * Path-traversal guard (source of truth): any `.`/`..`/empty segment is dropped,
 * so the value can never climb out of the agent home. The run provisioner
 * (ticket 4) runs `rm -rf` on this path for a `fresh` checkout, so a stray `../`
 * from a mis-typed scenario/profile config must not escape the sandbox. The
 * provisioner re-asserts containment as defense-in-depth, but neutralizing it
 * here at the only write surface keeps the persisted value clean too.
 */
export function normalizeWorkspaceFolder(input: any): string {
  if (input == null) return '';
  const raw = String(input).trim().replace(/^[/\\]+/, '');
  if (!raw) return '';
  return raw
    .split(/[/\\]+/)
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
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
 * Resolve the effective working folder as a working_dir-relative path under the
 * shared `.awb/qa` root (규약 ③): `<RUN_WORKSPACE_ROOT>/<leaf>`. The leaf is the
 * explicit `workspace_folder` when set, otherwise the scenario/profile id's
 * first 8 chars — parallel to the worktree slug's `<ticket8>` (규약 ②), keeping
 * the folder stable across runs of the same scenario/profile so a warm build
 * dir survives. `kind` is a last-ditch fallback for the leaf if the id is empty.
 *
 * QA scenarios and security profiles share the `.awb/qa` root (both kinds land
 * under it, keyed by their own id); UUID first-8 collision across the two id
 * spaces is negligible — the same tradeoff the worktree slug accepts.
 */
export function resolveWorkspaceFolder(
  folder: string | null | undefined,
  kind: 'qa' | 'security',
  id: string,
): string {
  const explicit = normalizeWorkspaceFolder(folder);
  const leaf = explicit || String(id || '').slice(0, 8) || kind;
  return `${RUN_WORKSPACE_ROOT}/${leaf}`;
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

// ── Run-provision wire contract (ticket 4 — QA/security dispatch → agent-manager) ─

/**
 * A repo the agent-manager provisioner can clone for a run, after the server has
 * already expanded a `repo_ref` (resource_id / board-environment_config) into a
 * concrete url. `branch` omitted = the repo's default branch.
 */
export interface RunRepoSpec {
  url: string;
  branch?: string;
}

/**
 * The structured provisioning hint the server ships on the QA/security run
 * dispatch (`chat_room_message` payload). It tells the agent-manager exactly
 * which folder to prepare and how, BEFORE the run subagent spawns — closing the
 * gap that ticket (3) left to the prompt alone:
 *   - `workspace_folder` is the resolved working_dir-relative folder under
 *     `.awb/qa` (`resolveWorkspaceFolder` output, e.g. `.awb/qa/<scenario8>`);
 *     the agent-manager joins it onto the agent's working_dir (규약 ③).
 *   - `repo` is the already-resolved clone source (or null = nothing to clone,
 *     just ensure the folder exists; the prompt still tells the agent what to do).
 *   - `checkout_mode` drives reuse (fetch+ff-pull / clone) vs fresh (wipe + clone).
 *   - `run_id` / `workspace_id` let the manager finalize the run as `error` if
 *     provisioning fails (the "dispatch 중단 + 코멘트" path).
 *
 * Provisioner = source sync only (checkout). Build/test stays the agent's job
 * (the responsibility boundary agreed with ticket (3)).
 */
export interface RunProvision {
  kind: 'qa' | 'security';
  run_id: string;
  workspace_id: string;
  workspace_folder: string;
  checkout_mode: CheckoutMode;
  repo: RunRepoSpec | null;
}

// ── Run-prompt block (reused by qa-prompt.ts + security-prompt.ts) ────────────

export interface WorkspaceFolderPromptInput {
  workspace_folder: string | null | undefined;
  repo_ref: WorkspaceFolderRepoRef | null | undefined;
  checkout_mode: CheckoutMode;
  build_mode: BuildMode;
  /** Server state — the last successfully-built commit (null until first build). */
  last_built_commit: string | null | undefined;
  kind: 'qa' | 'security';
  /** Scenario / profile id — feeds the deterministic default folder. */
  id: string;
}

/**
 * Render the imperative "where + how do I build" block injected into a QA /
 * security run prompt. worktree 규약 ③: the run working folder lives at
 * `<working_dir>/.awb/qa/<id8>` and the agent-manager provisioner checks it out
 * and PINS it as the run subagent's cwd BEFORE spawn — so the agent starts
 * INSIDE the folder and never improvises a location. The server never knows the
 * absolute working_dir, so the block names the working_dir-relative location for
 * the human/agent and drives every command off the current directory
 * (`RUN_WORKSPACE_PROMPT_PATH`), keeping the rendered path and the real cwd in
 * lockstep (the ticket's core invariant).
 *
 * The COLD/WARM decision stays server-authoritative (`decideRunFreshness`) and
 * imperative so the agent has **no inference to do** — no folder guess, no
 * re-clone on a warm run, no marker probing. Source checkout is the
 * provisioner's job (규약 ④ boundary); build/test stays the agent's — so the
 * block states the guaranteed prepared state rather than re-issuing clone/pull
 * commands, which have no well-defined shell form once the cwd IS the folder.
 */
export function renderWorkspaceFolderBlock(input: WorkspaceFolderPromptInput): string {
  const folder = resolveWorkspaceFolder(input.workspace_folder, input.kind, input.id);
  const checkout = normalizeCheckoutMode(input.checkout_mode);
  const build = normalizeBuildMode(input.build_mode);
  const freshness = decideRunFreshness({
    build_mode: build,
    checkout_mode: checkout,
    last_built_commit: input.last_built_commit ?? null,
  });

  // Location is stated `<working_dir>`-relative — the server has no clone and
  // cannot know the absolute working_dir. The provisioner pins the cwd to this
  // exact folder, so it is both the described path and the current directory.
  const displayPath = `<working_dir>/${folder}`;

  const ref = normalizeRepoRef(input.repo_ref);
  const branchSuffix = ref?.branch ? ` (branch \`${ref.branch}\`)` : '';
  let repoLine: string;
  if (ref?.url) {
    repoLine = `Cloned from \`${ref.url}\`${branchSuffix}.`;
  } else if (ref?.resource_id) {
    repoLine = `Repo Resource \`${ref.resource_id}\`${branchSuffix} (git URL / credentials resolved from AWB).`;
  } else {
    repoLine = `The repo configured for this board / workspace (\`environment_config\`)${branchSuffix}.`;
  }

  const buildLabel =
    freshness === 'cold'
      ? 'a **COLD build** (clean any prior build artifacts + full build from scratch)'
      : 'a **WARM build** (incremental — reuse the existing build artifacts; do NOT clean)';

  const preparedNote =
    checkout === 'fresh'
      ? 'wiped and freshly re-cloned'
      : 'reused and fast-forwarded to the latest commit';

  return [
    `## Working folder & build (server-decided — do NOT improvise)`,
    ``,
    `**Working folder:** \`${displayPath}\` — the run workspace has been prepared here for you`,
    `(${preparedNote}) and set as your **current directory** (\`${RUN_WORKSPACE_PROMPT_PATH}\`). Work **only** here; do`,
    `not \`cd\` elsewhere, re-clone, or build from any other location. Every run of this ${input.kind === 'qa' ? 'scenario' : 'profile'} reuses this exact path.`,
    ``,
    `**Repo:** ${repoLine}`,
    ``,
    `**This run is ${freshness.toUpperCase()}** — decided by the server (build_mode=\`${build}\`, checkout_mode=\`${checkout}\`${freshness === 'warm' || build === 'cold_then_warm' ? `, last_built_commit=${input.last_built_commit ? `\`${input.last_built_commit}\`` : 'none'}` : ''}). Do not second-guess this.`,
    ``,
    `1. Your working folder is ready (see above) and is your current directory — do **not** re-clone or create a new/arbitrary folder.`,
    `2. Run ${buildLabel}.`,
  ].join('\n');
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
