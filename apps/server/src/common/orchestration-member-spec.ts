/**
 * Runtime specs for Orchestration — two shapes, because a team and a mission
 * answer two different questions.
 *
 *   - `TeamSlotSpec` — a roster slot (orchestrator or member): **who** runs.
 *     Runtime Host + CLI + model + credential + backend profile + execution
 *     config. It has NO folder. A team is reused across missions, and missions
 *     work on different repositories, so the folder cannot belong to the team:
 *     a slot that named one folder tied the whole team to one repository, and
 *     the step's project folder then had to be explained away in the prompt
 *     ("the main clone is not your working folder…").
 *   - `TeamAgentSpec` — an **execution** spec: a slot placed in one folder. The
 *     folder comes from the mission's projects (`ProjectHostFolder`, the
 *     project's main clone on that host — see `slotExecutionSpec`). This is the
 *     shape the manager spawns from, the shape `runtimeIdentityKey` hashes, and
 *     the base of `RuntimeSpec` (tickets, chat, automation still declare their
 *     folder inline).
 *
 * A slot is therefore not an execution identity on its own: the same slot
 * resolves to one identity per project folder (`lower(cli) + working_dir +
 * credential_id`). Steps address the slot (`OrchestrationStep.assignee_slot`)
 * and the identity is derived per step from (slot, project). Two slots that
 * differ only by model legitimately share an identity once they work in the
 * same folder — they are the same CLI login in the same tree; the model rides
 * each dispatch's spec, not the identity.
 *
 * Stored as one `simple-json` column per slot (`OrchestrationTeamMember.spec`,
 * `OrchestrationTeam.orchestrator_spec`) rather than flat columns: the shape is
 * identical for both slots and nothing queries its interior. Rows written while
 * slots still carried `working_dir` / `folder_scope` keep those keys on disk;
 * `parseTeamSlotSpec` ignores them and the next save drops them.
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
 * Where a dispatched step runs, relative to its project folder (the project's
 * main clone on the assignee's host). A mission-level choice
 * (`OrchestrationMission.folder_scope`), copied into every execution spec.
 *
 *  - `shared`   — the step runs **in the project folder itself**. Every member
 *                 working on that project on that host shares one tree: they see
 *                 each other's files, one checkout, one node_modules. This is the
 *                 default because a team handing files to each other in place is
 *                 the common case.
 *  - `isolated` — the step runs in `<project folder>/.awb/orch/<mission>/<step_key>`,
 *                 provisioned (and checked out) per step. For missions that fan out
 *                 conflicting builds over the same repository.
 *
 * The tradeoff is real in both directions and the operator has to own it:
 * `shared` means two steps running at the same time can clobber each other's
 * working tree, and it deliberately skips the run provisioner (no clone, no
 * wipe) because pointing a `fresh` checkout at an operator's real checkout
 * would `rm -rf` it. `isolated` means members cannot see each other's work.
 */
export type MemberFolderScope = 'shared' | 'isolated';

export const MEMBER_FOLDER_SCOPES: readonly MemberFolderScope[] = ['shared', 'isolated'];
export const DEFAULT_MEMBER_FOLDER_SCOPE: MemberFolderScope = 'shared';

/** Read a stored/loose folder scope; anything unrecognised is the default. */
export function normalizeMemberFolderScope(value: unknown): MemberFolderScope {
  const raw = value == null ? '' : String(value).trim();
  return MEMBER_FOLDER_SCOPES.includes(raw as MemberFolderScope) ? (raw as MemberFolderScope) : DEFAULT_MEMBER_FOLDER_SCOPE;
}

/**
 * CLIs a team slot may name. `custom` is excluded on purpose — the manager
 * refuses to auto-spawn it (the operator supplies a launch script), so a team
 * slot pointing at one would accept work and never run it. This is exactly the
 * set `validateAgentRuntimeConfig` treats as executable.
 */
export const TEAM_SLOT_CLIS: readonly string[] = CLI_TYPES.filter((cli) => isExecutableRuntime(cli));

/** A team roster slot — who runs, never where. See the file header. */
export interface TeamSlotSpec {
  /** Runtime Host that will run this slot. */
  manager_agent_id: string;
  /** CLI to run — one of TEAM_SLOT_CLIS. */
  cli: string;
  /** Model id passed to the CLI. null/'' = the CLI's own default. */
  model: string | null;
  /** Optional per-slot CLI auth Credential. null = inherit the operator's login. */
  credential_id: string | null;
  /** Optional Claude backend profile id (instance-global). null = inherit. */
  cli_runtime_profile: string | null;
  /** Execution strategy + permission tier for this CLI. */
  runtime_config: AgentRuntimeConfig;
}

/** An execution spec: a slot placed in one folder. See the file header. */
export interface TeamAgentSpec extends TeamSlotSpec {
  /** Absolute path on the host. Required — the manager refuses to spawn without one. */
  working_dir: string;
  /** See MemberFolderScope. */
  folder_scope: MemberFolderScope;
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
 * The folder-free core shared by both shapes. Referential checks that need the
 * DB (does this host exist, is that credential visible, does that backend
 * profile exist) are NOT done here — the services that hold the repositories
 * do them. This function owns only the shape.
 */
function normalizeSlotCore(raw: Record<string, unknown>, label: string): TeamSlotSpec {
  const manager_agent_id = str(raw.manager_agent_id);
  if (!manager_agent_id) fail(label, 'manager_agent_id (Runtime Host) is required');

  const cli = str(raw.cli).toLowerCase();
  if (!cli) fail(label, 'cli is required');
  if (!TEAM_SLOT_CLIS.includes(cli)) {
    fail(label, `cli must be one of ${TEAM_SLOT_CLIS.join(', ')} (got "${cli}")`);
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
    credential_id: str(raw.credential_id) || null,
    cli_runtime_profile: str(raw.cli_runtime_profile) || null,
    runtime_config,
  };
}

function requireObject(input: unknown, label: string, expected: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail(label, `a runtime spec object is required (${expected})`);
  }
  return input as Record<string, unknown>;
}

/**
 * Validate + normalize loose REST/MCP input into a TeamSlotSpec.
 *
 * `working_dir` / `folder_scope` in the input are ignored rather than
 * rejected: they are what an older client still sends for a slot, and the
 * mission now decides both. Ignoring them loses nothing — the slot never
 * honoured a folder after this change.
 */
export function normalizeTeamSlotSpec(input: unknown, label: string): TeamSlotSpec {
  return normalizeSlotCore(requireObject(input, label, 'manager_agent_id, cli'), label);
}

/**
 * Read a persisted slot back. NEVER throws — a row written by an older build
 * (or hand-edited) degrades to "no spec" on a read path rather than breaking
 * the whole team listing. Accepts a JSON string too: a row written by raw SQL
 * (a migration, a hand fix) can hold the encoded form.
 */
export function parseTeamSlotSpec(value: unknown): TeamSlotSpec | null {
  const candidate = decodeStored(value);
  if (!candidate) return null;
  try {
    return normalizeTeamSlotSpec(candidate, 'spec');
  } catch {
    return null;
  }
}

/**
 * Merge a partial patch over an existing slot. Absent keys keep their current
 * value; this is what lets the UI PATCH just `model` without resending the
 * credential and runtime config.
 */
export function mergeTeamSlotSpec(current: TeamSlotSpec | null, patch: unknown, label: string): TeamSlotSpec {
  if (!current) return normalizeTeamSlotSpec(patch, label);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return current;
  const raw = patch as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...slotFields(current) };
  for (const key of Object.keys(merged)) {
    if (raw[key] !== undefined) merged[key] = raw[key];
  }
  carryRuntimeConfigAcrossCliChange(current, raw, merged);
  return normalizeTeamSlotSpec(merged, label);
}

/**
 * Place a slot in a folder — the execution spec a step (or the orchestrator)
 * is dispatched with. `workingDir` is the project's folder on the slot's host;
 * the caller resolved it from `ProjectHostFolder` and never guesses one.
 */
export function slotExecutionSpec(
  slot: TeamSlotSpec,
  workingDir: string,
  folderScope: MemberFolderScope,
): TeamAgentSpec {
  const dir = str(workingDir);
  if (!isAbsoluteHostPath(dir)) {
    throw new TeamAgentSpecError(`working folder must be an absolute path on the host (got "${dir}")`);
  }
  return { ...slotFields(slot), working_dir: dir, folder_scope: folderScope };
}

/** The folder-free part of any spec (slot or execution). */
export function slotOf(spec: TeamSlotSpec): TeamSlotSpec {
  return slotFields(spec);
}

/** Same slot — every field that changes how the CLI is launched is equal. */
export function sameTeamSlotSpec(a: TeamSlotSpec | null, b: TeamSlotSpec | null): boolean {
  if (!a || !b) return false;
  return slotSignature(a) === slotSignature(b);
}

/** Every field of a slot as one comparable string: host, cli, model, credential, backend profile, runtime_config. */
export function slotSignature(spec: TeamSlotSpec | null): string {
  return [
    spec?.manager_agent_id ?? '',
    spec?.cli ?? '',
    spec?.model ?? '',
    spec?.credential_id ?? '',
    spec?.cli_runtime_profile ?? '',
    JSON.stringify(spec?.runtime_config ?? null),
  ].join('\u0000');
}

/**
 * Validate + normalize loose input into an execution spec (slot + folder).
 * Used by `RuntimeSpec` (tickets, chat, automation) and for re-reading the
 * execution snapshots orchestration stores on missions and steps.
 *
 * `working_dir` must be absolute. A relative path would be silently joined onto
 * whatever the manager process's cwd happens to be, which is the kind of
 * "worked on my machine" bug that only shows up on the third host.
 */
export function normalizeTeamAgentSpec(input: unknown, label: string): TeamAgentSpec {
  const raw = requireObject(input, label, 'manager_agent_id, cli, working_dir');
  const core = normalizeSlotCore(raw, label);

  const working_dir = str(raw.working_dir);
  if (!working_dir) fail(label, 'working_dir is required — the Runtime Host refuses to spawn without one');
  if (!isAbsoluteHostPath(working_dir)) {
    fail(label, `working_dir must be an absolute path on the host (got "${working_dir}")`);
  }

  const scopeRaw = str(raw.folder_scope) || DEFAULT_MEMBER_FOLDER_SCOPE;
  if (!MEMBER_FOLDER_SCOPES.includes(scopeRaw as MemberFolderScope)) {
    fail(label, `folder_scope must be one of ${MEMBER_FOLDER_SCOPES.join(', ')}`);
  }

  return { ...core, working_dir, folder_scope: scopeRaw as MemberFolderScope };
}

/**
 * Read a persisted execution spec back. Like `parseTeamSlotSpec` this NEVER
 * throws; a spec without a folder (a slot, or a damaged row) reads as null.
 */
export function parseTeamAgentSpec(value: unknown): TeamAgentSpec | null {
  const candidate = decodeStored(value);
  if (!candidate) return null;
  try {
    return normalizeTeamAgentSpec(candidate, 'spec');
  } catch {
    return null;
  }
}

/**
 * Merge a partial patch over an existing execution spec (RuntimeSpec edits).
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
    ...slotFields(current),
    working_dir: current.working_dir,
    folder_scope: current.folder_scope,
  };
  for (const key of Object.keys(merged)) {
    if (raw[key] !== undefined) merged[key] = raw[key];
  }
  carryRuntimeConfigAcrossCliChange(current, raw, merged);
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

function slotFields(spec: TeamSlotSpec): TeamSlotSpec {
  return {
    manager_agent_id: spec.manager_agent_id,
    cli: spec.cli,
    model: spec.model,
    credential_id: spec.credential_id,
    cli_runtime_profile: spec.cli_runtime_profile,
    runtime_config: spec.runtime_config,
  };
}

/**
 * A CLI change can invalidate the old runtime_config: `strategy` is per-CLI
 * (cli-catalog.ts `collaboration` — today only hermes supports
 * delegated/swarm), so carrying `swarm` onto claude would be rejected for a
 * combination the operator never chose. Fall back to the one strategy every
 * CLI supports while KEEPING the permission tier — that is a deliberate
 * safety choice about what the agent may do, and silently resetting it to
 * the default on an unrelated CLI edit would loosen or tighten it behind the
 * operator's back. Likewise the profile / child-limit knobs only survive
 * when the new CLI declares them (`runtime_config.profiles` / `.child_limits`).
 */
function carryRuntimeConfigAcrossCliChange(
  current: TeamSlotSpec,
  raw: Record<string, unknown>,
  merged: Record<string, unknown>,
): void {
  if (raw.cli === undefined || str(raw.cli).toLowerCase() === current.cli || raw.runtime_config !== undefined) return;
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

function decodeStored(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  let candidate: unknown = value;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  return candidate as Record<string, unknown>;
}

function str(value: unknown): string {
  return value == null ? '' : String(value).trim();
}
