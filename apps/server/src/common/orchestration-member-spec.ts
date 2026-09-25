/**
 * Runtime spec for an Orchestration team slot (orchestrator or member).
 *
 * The team roster used to be "pick an Agent someone already created". That made
 * building a team a two-screen chore (go create N agents, come back, pick them)
 * and it hid the only axis that actually matters when you spread a mission over
 * several machines: **which host, which CLI, which model, which folder**. A team
 * slot is now declared by exactly that tuple, and AWB provisions the backing
 * Agent identity itself (see OrchestrationAgentProvisionerService).
 *
 * Why a backing Agent row still exists: every execution contract downstream of
 * the team is keyed on an Agent identity — the `agent_trigger` / `chat_room_message`
 * SSE scope, the per-agent MCP api key a spawned subagent reports back with,
 * ChatRoomParticipant rows, the `<Manager>/<Agent>` display rule, the
 * agent-manager's per-agent cli-home. Making a slot dispatchable without an
 * Agent row would mean rewriting all of those. So the Agent row stays and
 * becomes an *output* of the team editor rather than an input to it.
 *
 * Stored as one `simple-json` column per slot (`OrchestrationTeamMember.spec`,
 * `OrchestrationTeam.orchestrator_spec`) rather than a dozen flat columns: the
 * shape is identical for both slots, nothing queries its interior, and one
 * nullable additive column per table keeps SQLite-synchronize and the Postgres
 * migration trivial.
 */

import { CLI_TYPES } from './types/cli-types';
import { cliDescriptor, type CliCollaboration } from './cli-catalog';
import {
  AgentRuntimeConfig,
  AgentRuntimeConfigError,
  isExecutableRuntime,
  validateAgentRuntimeConfig,
} from './runtime-config';

/**
 * `Agent.origin` marking an identity AWB provisioned for a team slot. Lives here
 * rather than next to the provisioner so a reader (e.g. the agent listing, which
 * filters these out by default) can import the constant without pulling in the
 * provisioner's service graph — that import edge would run from AgentsModule
 * into AgentManagerModule's files, which already forwardRef back.
 */
export const ORCHESTRATION_AGENT_ORIGIN = 'orchestration';

/**
 * Where a dispatched step actually runs, relative to the slot's `working_dir`.
 *
 *  - `shared`   — the step runs **in `working_dir` itself**. Every slot that
 *                 names the same folder on the same host therefore shares one
 *                 tree: they see each other's files, one checkout, one
 *                 node_modules, and can leave notes for each other. This is the
 *                 point of the feature, so it is the default.
 *  - `isolated` — the step runs in `<working_dir>/.awb/orch/<mission>/<step_key>`,
 *                 provisioned (and optionally repo-cloned) per step. This is the
 *                 pre-refactor behaviour, kept for missions that fan out
 *                 conflicting builds over the same repo.
 *
 * The tradeoff is real in both directions and the operator has to own it:
 * `shared` means two steps running at the same time can clobber each other's
 * working tree, and it deliberately skips the run provisioner (no clone, no
 * wipe) because pointing a `fresh` checkout at an operator's real working_dir
 * would `rm -rf` it. `isolated` means members cannot see each other's work.
 */
export type MemberFolderScope = 'shared' | 'isolated';

export const MEMBER_FOLDER_SCOPES: readonly MemberFolderScope[] = ['shared', 'isolated'];
export const DEFAULT_MEMBER_FOLDER_SCOPE: MemberFolderScope = 'shared';

/**
 * CLIs a team slot may name. `custom` is excluded on purpose — the manager
 * refuses to auto-spawn it (the operator supplies a launch script), so a team
 * slot pointing at one would accept work and never run it. This is exactly the
 * set `validateAgentRuntimeConfig` treats as executable.
 */
export const TEAM_SLOT_CLIS: readonly string[] = CLI_TYPES.filter((cli) => isExecutableRuntime(cli));

export interface TeamAgentSpec {
  /** Runtime Host (`Agent.type === 'manager'`) that will run this slot. */
  manager_agent_id: string;
  /** CLI to run — one of TEAM_SLOT_CLIS. */
  cli: string;
  /** Model id passed to the CLI. null/'' = the CLI's own default. */
  model: string | null;
  /** Absolute path on the host. Required — the manager refuses to spawn without one. */
  working_dir: string;
  /** See MemberFolderScope. */
  folder_scope: MemberFolderScope;
  /** Optional per-slot CLI auth Credential. null = inherit the operator's login. */
  credential_id: string | null;
  /** Optional Claude backend profile id (instance-global). null = inherit. */
  cli_runtime_profile: string | null;
  /** Execution strategy + permission tier for this CLI. */
  runtime_config: AgentRuntimeConfig;
}

export class TeamAgentSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamAgentSpecError';
  }
}

function fail(label: string, message: string): never {
  throw new TeamAgentSpecError(`${label}: ${message}`);
}

/**
 * Validate + normalize loose REST/MCP input into a TeamAgentSpec.
 *
 * Referential checks that need the DB (does this manager exist, is that
 * credential visible in this workspace, does that backend profile exist) are
 * NOT done here — they live in the provisioner, which already holds the
 * repositories. This function owns only the shape.
 *
 * `working_dir` must be absolute. A relative path would be silently joined onto
 * whatever the manager process's cwd happens to be, which is the kind of
 * "worked on my machine" bug that only shows up on the third host.
 */
export function normalizeTeamAgentSpec(input: unknown, label: string): TeamAgentSpec {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail(label, 'a runtime spec object is required (manager_agent_id, cli, working_dir)');
  }
  const raw = input as Record<string, unknown>;

  const manager_agent_id = str(raw.manager_agent_id);
  if (!manager_agent_id) fail(label, 'manager_agent_id (Runtime Host) is required');

  const cli = str(raw.cli).toLowerCase();
  if (!cli) fail(label, 'cli is required');
  if (!TEAM_SLOT_CLIS.includes(cli)) {
    fail(label, `cli must be one of ${TEAM_SLOT_CLIS.join(', ')} (got "${cli}")`);
  }

  const working_dir = str(raw.working_dir);
  if (!working_dir) fail(label, 'working_dir is required — the Runtime Host refuses to spawn without one');
  if (!isAbsoluteHostPath(working_dir)) {
    fail(label, `working_dir must be an absolute path on the host (got "${working_dir}")`);
  }

  const scopeRaw = str(raw.folder_scope) || DEFAULT_MEMBER_FOLDER_SCOPE;
  if (!MEMBER_FOLDER_SCOPES.includes(scopeRaw as MemberFolderScope)) {
    fail(label, `folder_scope must be one of ${MEMBER_FOLDER_SCOPES.join(', ')}`);
  }

  let runtime_config: AgentRuntimeConfig;
  try {
    runtime_config = validateAgentRuntimeConfig(cli, raw.runtime_config);
  } catch (e) {
    if (e instanceof AgentRuntimeConfigError) fail(label, e.message);
    throw e;
  }

  return {
    manager_agent_id,
    cli,
    model: str(raw.model) || null,
    working_dir,
    folder_scope: scopeRaw as MemberFolderScope,
    credential_id: str(raw.credential_id) || null,
    cli_runtime_profile: str(raw.cli_runtime_profile) || null,
    runtime_config,
  };
}

/**
 * Read a persisted spec back. Unlike `normalizeTeamAgentSpec` this NEVER throws
 * — a row written by an older build (or hand-edited) has to degrade to "no
 * spec" on a read path rather than break the whole team listing. Callers that
 * need a spec to proceed check for null and say so.
 */
export function parseTeamAgentSpec(value: unknown): TeamAgentSpec | null {
  if (!value) return null;
  // A `simple-json` column normally hands back an object, but accept a JSON
  // string too: a row written by raw SQL (a migration, a hand fix) can hold the
  // encoded form, and silently reading that as "no spec" would downgrade a
  // perfectly good slot to un-editable.
  let candidate: unknown = value;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  try {
    return normalizeTeamAgentSpec(candidate, 'spec');
  } catch {
    return null;
  }
}

/**
 * Merge a partial patch over an existing spec. Absent keys keep their current
 * value; this is what lets the UI PATCH just `working_dir` without resending
 * the credential and runtime config.
 *
 * `runtime_config` is merged as a whole object, not key-by-key: its valid shapes
 * are per-CLI (`validateAgentRuntimeConfig` rejects a `swarm` strategy on a CLI
 * that has no collaboration support), so half-applying a patch across a CLI
 * change could produce a combination neither side asked for.
 */
export function mergeTeamAgentSpec(
  current: TeamAgentSpec | null,
  patch: unknown,
  label: string,
): TeamAgentSpec {
  if (!current) return normalizeTeamAgentSpec(patch, label);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return current;
  const raw = patch as Record<string, unknown>;
  const merged: Record<string, unknown> = {
    manager_agent_id: current.manager_agent_id,
    cli: current.cli,
    model: current.model,
    working_dir: current.working_dir,
    folder_scope: current.folder_scope,
    credential_id: current.credential_id,
    cli_runtime_profile: current.cli_runtime_profile,
    runtime_config: current.runtime_config,
  };
  for (const key of Object.keys(merged)) {
    if (raw[key] !== undefined) merged[key] = raw[key];
  }
  // A CLI change can invalidate the old runtime_config: `strategy` is per-CLI
  // (cli-catalog.ts `collaboration` — today only hermes supports
  // delegated/swarm), so carrying `swarm` onto claude would be rejected for a
  // combination the operator never chose. Fall back to the one strategy every
  // CLI supports while KEEPING the permission tier — that is a deliberate
  // safety choice about what the agent may do, and silently resetting it to
  // the default on an unrelated CLI edit would loosen or tighten it behind the
  // operator's back. Likewise the profile / child-limit knobs only survive
  // when the new CLI declares them (`runtime_config.profiles` / `.child_limits`).
  if (raw.cli !== undefined && str(raw.cli).toLowerCase() !== current.cli && raw.runtime_config === undefined) {
    const next = cliDescriptor(str(raw.cli));
    const rc: Record<string, unknown> = { ...current.runtime_config };
    if (!next || !next.collaboration.includes(rc.strategy as CliCollaboration)) rc.strategy = 'single';
    if (!next?.runtime_config.profiles) delete rc.profile;
    if (!next?.runtime_config.child_limits) {
      delete rc.max_children;
      delete rc.max_iterations;
    }
    merged.runtime_config = rc;
  }
  return normalizeTeamAgentSpec(merged, label);
}

/** Windows (`C:\…`, `\\host\share`) and POSIX (`/…`) absolute forms. */
export function isAbsoluteHostPath(path: string): boolean {
  return path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\');
}

/** Last path segment — used to label a slot whose folder is its distinguishing trait. */
export function workingDirLeaf(workingDir: string): string {
  const parts = workingDir.split(/[/\\]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : workingDir;
}

function str(value: unknown): string {
  return value == null ? '' : String(value).trim();
}
