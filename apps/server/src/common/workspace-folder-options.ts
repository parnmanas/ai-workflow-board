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
 *   - `workspace_folder` is the resolved agent-home-relative folder
 *     (`resolveWorkspaceFolder` output, e.g. `qa/<scenario_id>`).
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
 * security run prompt. This is the heart of ticket (3): the server resolves the
 * absolute-ish folder (relative to `$AWB_AGENT_MANAGER_HOME`, since the server
 * never knows the agent's real home path) and the COLD/WARM decision, then
 * states them as commands so the agent has **no inference to do** — it does not
 * guess a folder, does not re-clone on a warm run, and does not probe markers to
 * decide cold vs warm.
 *
 * Responsibility boundary with ticket (4): the prompt is written self-contained
 * (it tells the agent to clone/pull itself). When the agent-manager provisioner
 * lands and guarantees the checkout, the agent can skip the clone/pull and go
 * straight to the build — the block says so explicitly so no edit is needed here.
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

  // Path is stated relative to $AWB_AGENT_MANAGER_HOME — the server has no clone
  // and cannot know the absolute home, so the agent resolves the env var itself.
  const path = `"$AWB_AGENT_MANAGER_HOME/${folder}"`;

  const ref = normalizeRepoRef(input.repo_ref);
  const branchSuffix = ref?.branch ? ` (branch \`${ref.branch}\`)` : '';
  const branchCheckout = ref?.branch ? ` && git -C ${path} checkout ${ref.branch}` : '';
  // For the reuse `cd … && git pull` command the cwd is already the folder, so a
  // bare `git checkout <branch>` keeps the whole thing in one code span.
  const branchCheckoutInline = ref?.branch ? ` && git checkout ${ref.branch}` : '';
  let cloneCmd: string;
  let repoLine: string;
  if (ref?.url) {
    repoLine = `Clone from \`${ref.url}\`${branchSuffix}.`;
    cloneCmd = `git clone ${ref.url} ${path}${branchCheckout}`;
  } else if (ref?.resource_id) {
    repoLine = `Use repo Resource \`${ref.resource_id}\`${branchSuffix} — resolve its git URL / credentials from AWB, then clone it.`;
    cloneCmd = `git clone <resource ${ref.resource_id} url> ${path}${branchCheckout}`;
  } else {
    repoLine = `Use the repo configured for this board / workspace (\`environment_config\`)${branchSuffix}.`;
    cloneCmd = `git clone <board environment_config repo url> ${path}${branchCheckout}`;
  }

  const buildLabel =
    freshness === 'cold'
      ? 'a **COLD build** (clean checkout artifacts + full build from scratch)'
      : 'a **WARM build** (incremental — reuse the existing build artifacts; do NOT clean)';

  let steps: string[];
  if (checkout === 'fresh') {
    // fresh always wipes → always COLD (decideRunFreshness guarantees freshness==='cold' here).
    steps = [
      `1. **Wipe** the working folder: \`rm -rf ${path}\`.`,
      `2. Clone fresh: \`${cloneCmd}\`.`,
      `3. Run ${buildLabel}.`,
    ];
  } else if (freshness === 'cold') {
    steps = [
      `1. If ${path} does **not** exist, clone into it: \`${cloneCmd}\`. If it already exists, \`cd ${path} && git pull --ff-only${branchCheckoutInline}\`. Do NOT create a new/arbitrary folder.`,
      `2. Run ${buildLabel}.`,
    ];
  } else {
    steps = [
      `1. \`cd ${path} && git pull --ff-only${branchCheckoutInline}\`. Do **NOT** re-clone and do **NOT** create a new folder — reuse this exact checkout.`,
      `2. Run ${buildLabel}.`,
    ];
  }

  return [
    `## Working folder & build (server-decided — do NOT improvise)`,
    ``,
    `**Working folder:** \`$AWB_AGENT_MANAGER_HOME/${folder}\` — resolve \`$AWB_AGENT_MANAGER_HOME\` yourself`,
    `(the server does not know your absolute home path). Work **only** inside this folder; do not`,
    `clone into or build from any other location. Every run of this ${input.kind === 'qa' ? 'scenario' : 'profile'} reuses this exact path.`,
    ``,
    `**Repo:** ${repoLine}`,
    ``,
    `**This run is ${freshness.toUpperCase()}** — decided by the server (build_mode=\`${build}\`, checkout_mode=\`${checkout}\`${freshness === 'warm' || build === 'cold_then_warm' ? `, last_built_commit=${input.last_built_commit ? `\`${input.last_built_commit}\`` : 'none'}` : ''}). Do not second-guess this.`,
    ``,
    ...steps,
    ``,
    `> If the working folder was already prepared for you (checkout done by the provisioner), skip the clone/pull above and go straight to the build step.`,
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
