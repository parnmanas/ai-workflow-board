import type { CliAdapter } from '../../cli-adapters/base.js';
import type { RuntimePluginCapabilities } from '../domain/capabilities.js';

export type RuntimeTransportKind = 'cli' | 'acp' | 'llm';

export interface RuntimePluginManifest<TOwner = unknown> {
  readonly id: string;
  readonly transport: RuntimeTransportKind;
  readonly capabilities: RuntimePluginCapabilities;
  readonly createCliAdapter?: () => CliAdapter;
  readonly createOwner?: (options: unknown) => TOwner;
}

export function defineRuntimePlugin<T>(manifest: RuntimePluginManifest<T>): RuntimePluginManifest<T> {
  return Object.freeze({ ...manifest, capabilities: Object.freeze(manifest.capabilities) });
}
