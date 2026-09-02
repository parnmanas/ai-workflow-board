import type { ClaudeBackendProfile } from '../types';

export type RuntimeProfileLoadState = 'idle' | 'loading' | 'ready' | 'error';

function validSelection(
  selection: string,
  profiles: ClaudeBackendProfile[],
  loadState: RuntimeProfileLoadState,
): string {
  if (loadState !== 'ready') return '';
  if (selection === 'none') return selection;
  return profiles.some((profile) => profile.id === selection) ? selection : '';
}

export function reconcileRuntimeProfileSelection(
  selection: string,
  profiles: ClaudeBackendProfile[],
): string {
  if (!selection || selection === 'none') return selection;
  return profiles.some((profile) => profile.id === selection) ? selection : '';
}

export function runtimeProfileForAgentUpdate(
  cli: string,
  selection: string,
  profiles: ClaudeBackendProfile[],
  loadState: RuntimeProfileLoadState,
): string | null {
  if (cli !== 'claude') return 'none';
  return validSelection(selection, profiles, loadState) || null;
}

export function runtimeProfileForManagedAgentCreate(
  cli: string,
  selection: string,
  profiles: ClaudeBackendProfile[],
  loadState: RuntimeProfileLoadState,
): string | undefined {
  if (cli !== 'claude') return undefined;
  return validSelection(selection, profiles, loadState) || undefined;
}
