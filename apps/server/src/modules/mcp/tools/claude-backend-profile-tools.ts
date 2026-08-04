import { randomUUID } from 'crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DataSource } from 'typeorm';
import { Agent } from '../../../entities/Agent';
import { ClaudeBackendProfile } from '../../../entities/ClaudeBackendProfile';
import { Credential } from '../../../entities/Credential';
import { Workspace } from '../../../entities/Workspace';
import { WorkspaceClaudeBackendProfile } from '../../../entities/WorkspaceClaudeBackendProfile';
import {
  publicProfile,
  runtimeToProfileEntity,
} from '../../../common/claude-backend-registry';
import { ClaudeBackendProfileSchema } from '../../../common/cli-runtime-profiles';
import { ok, err } from '../shared/helpers';
import { getCallerAgent, type McpAgentContext } from '../shared/session-auth';
import type { ToolContext } from './context';

const REGISTRY_GATE_ERROR =
  'Unauthorized: Claude backend profile registry tools require a DB-backed, full-scope MCP key bound to an Agent.';

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

export async function assignWorkspaceBackendProfile(
  dataSource: DataSource,
  workspaceId: string,
  profileId: string,
  setDefault: boolean,
) {
  const workspaceRepo = dataSource.getRepository(Workspace);
  const workspace = await workspaceRepo.findOne({
    where: { id: workspaceId },
  });
  if (!workspace) throw new Error('Workspace not found');
  const profile = await dataSource.getRepository(ClaudeBackendProfile).findOne({
    where: { id: profileId },
  });
  if (!profile) throw new Error('Claude backend profile not found');
  if (profile.credential_ref) {
    const credential = await dataSource.getRepository(Credential).findOne({
      where: { id: profile.credential_ref },
    });
    if (
      !credential ||
      (credential.workspace_id !== null && credential.workspace_id !== workspaceId)
    ) {
      throw new Error('Claude backend profile credential is not owned by this workspace');
    }
  }

  const linkRepo = dataSource.getRepository(WorkspaceClaudeBackendProfile);
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
