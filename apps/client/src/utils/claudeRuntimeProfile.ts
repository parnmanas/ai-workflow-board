import type { ClaudeBackendProfile } from '../types';
import { cliSupportsBackendProfile } from '../cli/catalog';

export type RuntimeProfileLoadState = 'idle' | 'loading' | 'ready' | 'error';

// Backend profiles only exist for CLIs whose catalog descriptor says so
// (`sessions.backend_profile`); every other CLI short-circuits to "no profile".

export function runtimeProfileSelectionReady(
  cli: string,
  loadState: RuntimeProfileLoadState,
): boolean {
  return !cliSupportsBackendProfile(cli) || loadState === 'ready';
}

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
  if (!cliSupportsBackendProfile(cli)) return 'none';
  return validSelection(selection, profiles, loadState) || null;
}

export function runtimeProfileForManagedAgentCreate(
  cli: string,
  selection: string,
  profiles: ClaudeBackendProfile[],
  loadState: RuntimeProfileLoadState,
): string | undefined {
  if (!cliSupportsBackendProfile(cli)) return undefined;
  return validSelection(selection, profiles, loadState) || undefined;
}
