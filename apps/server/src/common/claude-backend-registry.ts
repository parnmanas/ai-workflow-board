import { DataSource, In } from 'typeorm';
import { ClaudeBackendProfile } from '../entities/ClaudeBackendProfile';
import { WorkspaceClaudeBackendProfile } from '../entities/WorkspaceClaudeBackendProfile';
import { Workspace } from '../entities/Workspace';
import { CliRuntimeProfile, ClaudeBackendProfileSchema, parseCliRuntimeProfiles } from './cli-runtime-profiles';

const CORE_KEYS = new Set(['id', 'name', 'protocol', 'base_url', 'model', 'credential_ref']);

export function profileEntityToRuntime(row: ClaudeBackendProfile): CliRuntimeProfile {
  const config = JSON.parse(row.config || '{}');
  return ClaudeBackendProfileSchema.parse({
    ...config,
    id: row.id,
    protocol: row.protocol,
    base_url: row.base_url,
    model: row.model,
    ...(row.credential_ref ? { credential_ref: row.credential_ref } : {}),
  });
}

export function runtimeToProfileEntity(
  runtime: CliRuntimeProfile,
  name: string,
): Pick<ClaudeBackendProfile, 'id' | 'name' | 'protocol' | 'base_url' | 'model' | 'credential_ref' | 'config'> {
  const config = Object.fromEntries(
    Object.entries(runtime).filter(([key]) => !CORE_KEYS.has(key)),
  );
  return {
    id: runtime.id,
    name,
    protocol: runtime.protocol,
    base_url: runtime.base_url,
    model: runtime.model,
    credential_ref: runtime.credential_ref ?? null,
    config: JSON.stringify(config),
  };
}

export function publicProfile(row: ClaudeBackendProfile) {
  const runtime = profileEntityToRuntime(row);
  const { credential_ref: _credential, ...safe } = runtime;
  return {
    ...safe,
    name: row.name,
    credential_status: row.credential_ref ? 'configured' : 'missing',
  };
}

export async function workspaceRuntimeProfiles(dataSource: DataSource, workspaceId: string) {
  const links = await dataSource.getRepository(WorkspaceClaudeBackendProfile).find({
    where: { workspace_id: workspaceId },
  });
  if (!links.length) return [];
  const rows = await dataSource.getRepository(ClaudeBackendProfile).find({
    where: { id: In(links.map(link => link.profile_id)) },
  });
  return rows.map(profileEntityToRuntime);
}

export async function authoritativeWorkspaceRuntimeProfiles(
  dataSource: DataSource,
  workspace: Workspace | null | undefined,
) {
  if (!workspace) return [];
  const registryProfiles = await workspaceRuntimeProfiles(dataSource, workspace.id);
  return workspace.claude_backend_profiles_migrated
    ? registryProfiles
    : parseCliRuntimeProfiles(workspace.cli_runtime_profiles);
}
