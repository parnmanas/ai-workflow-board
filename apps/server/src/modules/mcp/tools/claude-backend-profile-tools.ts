import { randomUUID } from 'crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DataSource, EntityManager } from 'typeorm';
import { Agent } from '../../../entities/Agent';
import { ClaudeBackendProfile } from '../../../entities/ClaudeBackendProfile';
import { Credential } from '../../../entities/Credential';
import { Workspace } from '../../../entities/Workspace';
import { WorkspaceClaudeBackendProfile } from '../../../entities/WorkspaceClaudeBackendProfile';
import {
  profileEntityToRuntime,
  publicProfile,
  runtimeToProfileEntity,
} from '../../../common/claude-backend-registry';
import { ClaudeBackendProfileSchema } from '../../../common/cli-runtime-profiles';
import { ok, err } from '../shared/helpers';
import { getCallerAgent, type McpAgentContext } from '../shared/session-auth';
import type { ToolContext } from './context';

const REGISTRY_GATE_ERROR =
  'Unauthorized: Claude backend profile registry tools require a DB-backed, full-scope MCP key bound to an Agent.';

const profileOperationTails = new Map<string, Promise<void>>();
const profileQueueBypassDataSources = new WeakSet<DataSource>();
let profileLockHook: ((operation: 'update' | 'assign', profileId: string) => Promise<void>) | undefined;
let profileLockAttemptHook: ((operation: 'update' | 'assign', profileId: string) => void) | undefined;

export function setProfileLockHookForTests(
  hook?: (operation: 'update' | 'assign', profileId: string) => Promise<void>,
): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('profile lock hook is test-only');
  profileLockHook = hook;
}

export function setProfileLockAttemptHookForTests(
  hook?: (operation: 'update' | 'assign', profileId: string) => void,
): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('profile lock hook is test-only');
  profileLockAttemptHook = hook;
}

export function setProfileQueueBypassForTests(dataSource: DataSource, enabled = true): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('profile queue bypass is test-only');
  if (enabled) profileQueueBypassDataSources.add(dataSource);
  else profileQueueBypassDataSources.delete(dataSource);
}

async function withProfileWriteLock<T>(
  dataSource: DataSource,
  profileId: string,
  operationName: 'update' | 'assign',
  operation: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  const bypassQueue = profileQueueBypassDataSources.has(dataSource);
  const previous = bypassQueue
    ? Promise.resolve()
    : profileOperationTails.get(profileId) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>(resolve => { release = resolve; });
  if (!bypassQueue) profileOperationTails.set(profileId, tail);
  profileLockAttemptHook?.(operationName, profileId);
  await previous;
  try {
    return await dataSource.transaction(async manager => {
      // This no-op UPDATE takes a row write lock for the transaction on server
      // databases.  The per-process queue above provides the equivalent
      // serialization for sql.js, which has no SELECT ... FOR UPDATE support.
      const locked = await manager.createQueryBuilder()
        .update('claude_backend_profiles')
        .set({ id: () => 'id' })
        .where('id = :profileId', { profileId })
        .execute();
      if ((locked.affected ?? 0) === 0) {
        throw new Error('Claude backend profile not found');
      }
      await profileLockHook?.(operationName, profileId);
      return operation(manager);
    });
  } finally {
    release();
    if (!bypassQueue && profileOperationTails.get(profileId) === tail) {
      profileOperationTails.delete(profileId);
    }
  }
}

export async function requireAgentRegistryAccess(
  dataSource: DataSource,
  caller: McpAgentContext | undefined,
): Promise<string | null> {
  if (
    !caller ||
    caller.source !== 'db' ||
    caller.scope !== 'full' ||
    !caller.agentId
  ) {
    return REGISTRY_GATE_ERROR;
  }
  const agent = await dataSource.getRepository(Agent).findOne({
    where: { id: caller.agentId },
  });
  return agent ? null : REGISTRY_GATE_ERROR;
}

export async function upsertClaudeBackendProfile(
  dataSource: DataSource,
  input: {
    name: string;
    base_url: string;
    model: string;
    protocol: 'anthropic-compatible' | 'openai-compatible';
    credential_ref?: string;
    config?: Record<string, unknown>;
  },
) {
  const name = input.name.trim();
  if (!name) throw new Error('name is required');

  const repo = dataSource.getRepository(ClaudeBackendProfile);
  const existing = await repo.findOne({ where: { name } });
  if (existing) {
    if (
      existing.base_url !== input.base_url ||
      existing.model !== input.model ||
      existing.protocol !== input.protocol
    ) {
      throw new Error(
        `Profile name "${name}" already exists with a different base_url, model, or protocol; refusing to overwrite it.`,
      );
    }
    return { created: false, profile: publicProfile(existing) };
  }

  if (input.credential_ref) {
    const credential = await dataSource.getRepository(Credential).findOne({
      where: { id: input.credential_ref },
    });
    if (!credential) throw new Error('credential_ref does not identify an existing Credential');
  }

  const runtime = ClaudeBackendProfileSchema.parse({
    ...(input.config ?? {}),
    id: randomUUID(),
    kind: 'claude-backend',
    protocol: input.protocol,
    base_url: input.base_url,
    model: input.model,
    ...(input.credential_ref ? { credential_ref: input.credential_ref } : {}),
  });

  try {
    const saved = await repo.save(repo.create(runtimeToProfileEntity(runtime, name)));
    return { created: true, profile: publicProfile(saved) };
  } catch (error) {
    // A concurrent caller may have won the unique-name insert. Re-read and
    // apply the same collision guard so retries remain exactly-once.
    const winner = await repo.findOne({ where: { name } });
    if (
      winner &&
      winner.base_url === input.base_url &&
      winner.model === input.model &&
      winner.protocol === input.protocol
    ) {
      return { created: false, profile: publicProfile(winner) };
    }
    throw error;
  }
}

export async function updateClaudeBackendProfile(
  dataSource: DataSource,
  profileId: string,
  input: {
    name?: string;
    base_url?: string;
    model?: string;
    protocol?: 'anthropic-compatible' | 'openai-compatible';
    credential_ref?: string | null;
    config?: Record<string, unknown>;
  },
) {
  return withProfileWriteLock(dataSource, profileId, 'update', async manager => {
  const repo = manager.getRepository(ClaudeBackendProfile);
  const current = await repo.findOne({ where: { id: profileId } });
  if (!current) throw new Error('Claude backend profile not found');

  const name = input.name === undefined ? current.name : input.name.trim();
  if (!name) throw new Error('name is required');
  const existingRuntime = profileEntityToRuntime(current);
  const runtime = ClaudeBackendProfileSchema.parse({
    ...existingRuntime,
    ...(input.config ?? {}),
    id: profileId,
    ...(input.base_url === undefined ? {} : { base_url: input.base_url }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.protocol === undefined ? {} : { protocol: input.protocol }),
    ...(input.credential_ref === undefined
      ? {}
      : input.credential_ref === null
        ? { credential_ref: undefined }
        : { credential_ref: input.credential_ref }),
  });

  if (runtime.credential_ref) {
    const credential = await manager.getRepository(Credential).findOne({
      where: { id: runtime.credential_ref },
    });
    if (!credential) throw new Error('credential_ref does not identify an existing Credential');
    if (credential.workspace_id !== null) {
      const assignments = await manager
        .getRepository(WorkspaceClaudeBackendProfile)
        .find({
          where: { profile_id: profileId },
          select: { workspace_id: true },
        });
      if (assignments.some(link => link.workspace_id !== credential.workspace_id)) {
        throw new Error(
          'Claude backend profile credential is not owned by every assigned workspace',
        );
      }
    }
  }

  const next = runtimeToProfileEntity(runtime, name);
  const changed = (
    current.name !== next.name ||
    current.base_url !== next.base_url ||
    current.model !== next.model ||
    current.protocol !== next.protocol ||
    current.credential_ref !== next.credential_ref ||
    current.config !== next.config
  );
  if (!changed) return { changed: false, profile: publicProfile(current) };
  Object.assign(current, next);
  try {
    const saved = await repo.save(current);
    return { changed, profile: publicProfile(saved) };
  } catch (error) {
    throw new Error(`profile name already exists: ${error instanceof Error ? error.message : String(error)}`);
  }
  });
}

export async function assignWorkspaceBackendProfile(
  dataSource: DataSource,
  workspaceId: string,
  profileId: string,
  setDefault: boolean,
) {
  // Preserve the public validation order before entering the profile-keyed
  // critical section; the workspace is re-read inside the transaction.
  const requestedWorkspace = await dataSource.getRepository(Workspace).findOne({
    where: { id: workspaceId },
  });
  if (!requestedWorkspace) throw new Error('Workspace not found');
  return withProfileWriteLock(dataSource, profileId, 'assign', async manager => {
  const workspaceRepo = manager.getRepository(Workspace);
  const workspace = await workspaceRepo.findOne({
    where: { id: workspaceId },
  });
  if (!workspace) throw new Error('Workspace not found');
  const profile = await manager.getRepository(ClaudeBackendProfile).findOne({
    where: { id: profileId },
  });
  if (!profile) throw new Error('Claude backend profile not found');
  if (profile.credential_ref) {
    const credential = await manager.getRepository(Credential).findOne({
      where: { id: profile.credential_ref },
    });
    if (
      !credential ||
      (credential.workspace_id !== null && credential.workspace_id !== workspaceId)
    ) {
      throw new Error('Claude backend profile credential is not owned by this workspace');
    }
  }

  const linkRepo = manager.getRepository(WorkspaceClaudeBackendProfile);
  const inserted = await linkRepo.createQueryBuilder()
    .insert()
    .values({
      workspace_id: workspaceId,
      profile_id: profileId,
    })
    .orIgnore()
    .execute();
  let changed = (
    inserted.raw?.changes ??
    (Array.isArray(inserted.raw) ? inserted.raw.length : 0)
  ) > 0;

  if (setDefault && workspace.default_claude_backend_profile_id !== profileId) {
    workspace.default_claude_backend_profile_id = profileId;
    workspace.default_cli_runtime_profile = profileId;
    changed = true;
  }
  if (!workspace.claude_backend_profiles_migrated) {
    workspace.claude_backend_profiles_migrated = true;
    changed = true;
  }
  if (changed) await workspaceRepo.save(workspace);

  const links = await linkRepo.find({ where: { workspace_id: workspaceId } });
  return {
    changed,
    workspace_id: workspaceId,
    profile: publicProfile(profile),
    allowed_profile_ids: links.map(link => link.profile_id).sort(),
    default_profile_id: workspace.default_claude_backend_profile_id,
  };
  });
}

export async function listClaudeBackendProfiles(
  dataSource: DataSource,
  workspaceId?: string,
) {
  const rows = await dataSource.getRepository(ClaudeBackendProfile).find({
    order: { name: 'ASC' },
  });
  if (!workspaceId) return { profiles: rows.map(publicProfile) };

  const workspace = await dataSource.getRepository(Workspace).findOne({
    where: { id: workspaceId },
  });
  if (!workspace) throw new Error('Workspace not found');
  const links = await dataSource.getRepository(WorkspaceClaudeBackendProfile).find({
    where: { workspace_id: workspaceId },
  });
  return {
    profiles: rows.map(publicProfile),
    workspace_id: workspaceId,
    allowed_profile_ids: links.map(link => link.profile_id).sort(),
    default_profile_id: workspace.default_claude_backend_profile_id,
  };
}

export function registerClaudeBackendProfileTools(server: McpServer, ctx: ToolContext): void {
  const gated = async (
    extra: { sessionId?: string },
    operation: () => Promise<unknown>,
  ) => {
    const denied = await requireAgentRegistryAccess(
      ctx.dataSource,
      getCallerAgent(extra),
    );
    if (denied) return err(denied);
    try {
      return ok(await operation());
    } catch (error) {
      return err(error instanceof Error ? error.message : String(error));
    }
  };

  server.tool(
    'update_claude_backend_profile',
    'Update selected fields of an existing instance-global Claude backend profile while preserving its UUID and assignments. Pass credential_ref=null to clear it. DB-backed, full-scope Agent MCP only.',
    {
      profile_id: z.string().uuid(),
      name: z.string().min(1).optional(),
      base_url: z.string().url().optional(),
      model: z.string().min(1).optional(),
      protocol: z.enum(['anthropic-compatible', 'openai-compatible']).optional(),
      credential_ref: z.string().uuid().nullable().optional(),
      config: z.record(z.string(), z.unknown()).optional(),
    },
    async ({ profile_id, ...input }, extra) => gated(
      extra,
      () => updateClaudeBackendProfile(ctx.dataSource, profile_id, input),
    ),
  );

  server.tool(
    'upsert_claude_backend_profile',
    'Idempotently create or reuse an instance-global Claude backend profile. Refuses to overwrite a same-name profile whose endpoint, model, or protocol differs. DB-backed, full-scope Agent MCP only.',
    {
      name: z.string().min(1),
      base_url: z.string().url(),
      model: z.string().min(1),
      protocol: z.enum(['anthropic-compatible', 'openai-compatible']),
      credential_ref: z.string().uuid().optional(),
      config: z.record(z.string(), z.unknown()).optional(),
    },
    async (args, extra) => gated(
      extra,
      () => upsertClaudeBackendProfile(ctx.dataSource, args),
    ),
  );

  server.tool(
    'assign_workspace_backend_profile',
    'Idempotently add a Claude backend profile to a workspace allow-set and optionally make it the workspace default. Existing unrelated assignments are preserved. DB-backed, full-scope Agent MCP only.',
    {
      workspace_id: z.string().uuid(),
      profile_id: z.string().min(1),
      set_default: z.boolean().optional().default(true),
    },
    async ({ workspace_id, profile_id, set_default }, extra) => gated(
      extra,
      () => assignWorkspaceBackendProfile(
        ctx.dataSource,
        workspace_id,
        profile_id,
        set_default,
      ),
    ),
  );

  server.tool(
    'list_claude_backend_profiles',
    'List safe Claude backend profile metadata and, when workspace_id is supplied, its assignment/default verification state. Credential references and secrets are omitted. DB-backed, full-scope Agent MCP only.',
    {
      workspace_id: z.string().uuid().optional(),
    },
    async ({ workspace_id }, extra) => gated(
      extra,
      () => listClaudeBackendProfiles(ctx.dataSource, workspace_id),
    ),
  );
}
