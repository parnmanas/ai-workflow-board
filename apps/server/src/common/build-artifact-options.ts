import { z } from 'zod';
import { WorkspaceFolderRepoRef } from './workspace-folder-options';

/**
 * Build & Artifact Registry — shared identity/normalization + prompt rendering
 * (ticket 80d52250). Owns the ONE place that turns a loose repo reference into a
 * stable `repo_key`, plus the zod schema the MCP tools reuse and the imperative
 * "check the registry before you build" prompt block.
 *
 * The registry's whole value is a DETERMINISTIC cold/warm answer: "is there an
 * `ok` artifact for THIS exact commit + target?" instead of the old
 * `last_built_commit`-is-non-empty heuristic that returned WARM even when the
 * stored commit was stale relative to the HEAD being tested (the 0da1d237 /
 * 3f28dd05 stale-warm-exe race). For that to work, two scenarios pointing at the
 * same repo MUST hash to the same key — hence the normalization here is the
 * single source of truth.
 */

/**
 * A repo reference the registry can identify. A subset of WorkspaceFolderRepoRef
 * (we ignore `branch` for identity — a build is keyed by its commit_sha, not the
 * branch it was reached from).
 */
export interface BuildRepoRef {
  resource_id?: string;
  url?: string;
}

/**
 * Normalize a git URL so trivially-different spellings of the same repo collapse
 * to one key: lowercase, trim, strip a `git+` scheme prefix, a trailing `.git`,
 * and any trailing slash. Handles both `https://host/org/repo(.git)` and
 * scp-style `git@host:org/repo(.git)`.
 */
export function normalizeRepoUrl(url: string): string {
  return String(url ?? '')
    .trim()
    .replace(/^git\+/i, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .toLowerCase();
}

/**
 * Derive the stable lookup key from a repo reference. `resource_id` wins (it is
 * the canonical, auth-carrying identity); otherwise a normalized url. Returns ''
 * when nothing usable is present — the caller (service) turns that into a 400 so
 * an unidentifiable build never silently pollutes the registry under an empty key.
 */
export function buildRepoKey(ref: BuildRepoRef | WorkspaceFolderRepoRef | null | undefined): string {
  if (!ref || typeof ref !== 'object') return '';
  const resourceId = ref.resource_id != null ? String(ref.resource_id).trim() : '';
  if (resourceId) return `resource:${resourceId}`;
  const url = ref.url != null ? normalizeRepoUrl(ref.url) : '';
  if (url) return `url:${url}`;
  return '';
}

/**
 * Normalize a free-text `build_target` (platform/config selector, e.g.
 * `windows/Development`). Free-form on purpose so a new target never needs a
 * schema change; we only trim. '' = unset → the caller falls back (qa_driver for
 * a QA scenario) at prompt-render time.
 */
export function normalizeBuildTarget(input: any): string {
  return String(input ?? '').trim();
}

export const BUILD_ARTIFACT_STATUSES = ['building', 'ok', 'failed'] as const;

/** Zod schema for the `repo` argument shared by the build MCP tools. */
export const buildRepoRefSchema = z
  .object({
    resource_id: z.string().optional().describe('Checked-in repo Resource id (preferred, canonical identity)'),
    url: z.string().optional().describe('Raw git URL (used when there is no Resource; e.g. `git -C <folder> remote get-url origin`)'),
  })
  .describe('Repo identity for the artifact. Provide resource_id OR url — one is required so the artifact has a stable share key.');

// ── Prompt block — "check the registry before you build" (ticket #2/#3) ────────

export interface BuildRegistryPromptInput {
  /** Workspace id to pass to the tools. */
  workspace_id: string;
  /** The QA/SecurityRun id — report_build_failure finalizes this run. */
  run_id: string;
  kind: 'qa' | 'security';
  /** The scenario/profile repo_ref (may be null → build from the board repo). */
  repo_ref: WorkspaceFolderRepoRef | null | undefined;
  /** Resolved build target string (caller applies its own fallback). */
  build_target: string;
  /** The run working-folder path token, as rendered by the working-folder block
   *  — the provisioner pins the run subagent cwd to the resolved folder (규약 ③),
   *  so this is `RUN_WORKSPACE_PROMPT_PATH` (the current directory). */
  work_path: string;
}

/**
 * Render the imperative registry block appended to a run prompt. It supersedes
 * the COLD/WARM hint from the working-folder block: the agent asks the server
 * (get_latest_artifact) whether THIS commit is already built, and only builds if
 * not — closing the stale-warm race at the source. On success it registers the
 * artifact (so the NEXT run of ANY scenario on the same repo+commit reuses it);
 * on failure it reports a first-class `build_failed` instead of a generic error.
 *
 * `<REPO>` is rendered as the concrete JSON the agent should pass, derived from
 * repo_ref. When repo_ref carries no explicit identity (board environment_config
 * repo), the agent is told to resolve the folder's `origin` url itself so the
 * key still matches across scenarios sharing that repo.
 */
export function renderBuildRegistryBlock(input: BuildRegistryPromptInput): string {
  const target = (input.build_target || '').trim() || '<platform>/<config>';
  const rid = input.repo_ref?.resource_id ? String(input.repo_ref.resource_id).trim() : '';
  const rurl = input.repo_ref?.url ? String(input.repo_ref.url).trim() : '';

  let repoJson: string;
  let repoNote: string;
  if (rid) {
    repoJson = `{ "resource_id": "${rid}" }`;
    repoNote = '';
  } else if (rurl) {
    repoJson = `{ "url": "${rurl}" }`;
    repoNote = '';
  } else {
    repoJson = `{ "url": "<origin url>" }`;
    repoNote =
      ` (resolve \`<origin url>\` yourself: \`git -C ${input.work_path} remote get-url origin\` — ` +
      `use the SAME value every run so the artifact share key stays stable)`;
  }

  return [
    `## Build artifact registry — check before you build (server-authoritative freshness)`,
    ``,
    `This ${input.kind === 'qa' ? 'scenario' : 'profile'} tracks builds in a first-class registry. **The COLD/WARM hint above is a`,
    `fallback** — the AUTHORITATIVE cold/warm answer is "does the registry already hold an \`ok\``,
    `artifact for this exact commit + target?". Follow these steps so a build is never repeated`,
    `needlessly and a build death is never swallowed:`,
    ``,
    `1. Resolve the working-folder HEAD: \`HEAD=$(git -C ${input.work_path} rev-parse HEAD)\`.`,
    `2. **Query the registry** — call \`get_latest_artifact\` with`,
    `   \`{ "workspace_id": "${input.workspace_id}", "repo": ${repoJson}, "target": "${target}", "commit_sha": "$HEAD" }\`${repoNote}.`,
    `   - If the result has \`"is_fresh": true\`, an \`ok\` artifact for THIS commit already exists at`,
    `     \`commit_match.artifact_path\` — **REUSE it and SKIP the build entirely**. Go straight to the run steps.`,
    `   - Otherwise, run the build as described in the working-folder block.`,
    `3. **On a successful build**, register it so the next run (any scenario on this repo) can reuse it —`,
    `   \`register_build_artifact\` with`,
    `   \`{ "workspace_id": "${input.workspace_id}", "repo": ${repoJson}, "target": "${target}", "commit_sha": "$HEAD", "artifact_path": "<abs path to the built exe/output>", "host": "$(hostname)" }\`.`,
    `4. **If the build FAILS**, do NOT call \`complete_qa_run\`. Call`,
    `   \`report_build_failure\` with`,
    `   \`{ "workspace_id": "${input.workspace_id}", "run_id": "${input.run_id}", "repo": ${repoJson}, "target": "${target}", "commit_sha": "$HEAD", "log_summary": "<the build error tail, ~last 40 lines>" }\`.`,
    `   This finalizes the run as \`build_failed\` (a first-class build death — never a phantom \`running\` or a`,
    `   generic \`error\`) and attaches the build log to the auto-filed fix ticket.`,
  ].join('\n');
}
