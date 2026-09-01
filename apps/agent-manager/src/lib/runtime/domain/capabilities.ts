import type { RuntimeCapabilities } from '../runtime-types.js';
import type { RuntimeRequestOption } from './execution.js';

export interface RuntimePluginCapabilities extends RuntimeCapabilities {
  readonly request: Readonly<Record<RuntimeRequestOption, boolean>>;
}

export function requestCapabilities(
  capabilities: RuntimeCapabilities,
  overrides: Partial<Record<RuntimeRequestOption, boolean>> = {},
): RuntimePluginCapabilities {
  return Object.freeze({
    ...capabilities,
    request: Object.freeze({
      model: true,
      effort: false,
      sessionId: capabilities.session !== 'oneshot',
      systemPrompt: true,
      mcpServers: capabilities.native_mcp,
      streaming: capabilities.protocol !== 'jsonl',
      ...overrides,
    }),
  });
}
