import { DataSource, In } from 'typeorm';
import { ClaudeBackendProfile } from '../entities/ClaudeBackendProfile';
import { WorkspaceClaudeBackendProfile } from '../entities/WorkspaceClaudeBackendProfile';
import { Workspace } from '../entities/Workspace';
import { SystemSetting } from '../entities/SystemSetting';
import {
  CliRuntimeProfile, ClaudeBackendProfileSchema, parseCliRuntimeProfiles, resolveCliRuntimeProfile,
} from './cli-runtime-profiles';

const CORE_KEYS = new Set(['id', 'name', 'protocol', 'base_url', 'model', 'credential_ref']);
export const CLAUDE_BACKEND_DEFAULT_KEY = 'claude_backend_profiles.default';

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

export async function resolveClaudeBackendProfileForDispatch(
  dataSource: DataSource,
  workspace: Workspace | null | undefined,
  selectors: Array<{ source: string; value: string | null | undefined }>,
) {
  const profiles = await authoritativeWorkspaceRuntimeProfiles(dataSource, workspace);
  const globalDefault = (await dataSource.getRepository(SystemSetting).findOne({
    where: { key: CLAUDE_BACKEND_DEFAULT_KEY },
  }))?.value || null;
  if (globalDefault && globalDefault !== 'none' && !profiles.some(profile => profile.id === globalDefault)) {
    const globalRow = await dataSource.getRepository(ClaudeBackendProfile).findOne({
      where: { id: globalDefault },
    });
    if (globalRow) profiles.push(profileEntityToRuntime(globalRow));
  }
  return resolveCliRuntimeProfile(profiles, [
    ...selectors,
    {
      source: 'workspace',
      value: workspace?.default_claude_backend_profile_id ?? workspace?.default_cli_runtime_profile,
    },
    { source: 'global', value: globalDefault },
  ]);
}
