import type { RuntimePluginCapabilities } from '../domain/capabilities.js';
import type { NegotiatedRuntimeRequest, NormalizedRuntimeRequest, RuntimeRequestOption } from '../domain/execution.js';

const OPTIONAL_FIELDS: readonly RuntimeRequestOption[] = [
  'model', 'effort', 'sessionId', 'systemPrompt', 'mcpServers', 'streaming',
];

export function negotiateCapabilities(
  request: NormalizedRuntimeRequest,
  capabilities: RuntimePluginCapabilities,
): NegotiatedRuntimeRequest {
  const output: Record<string, unknown> = { ...request };
  const omitted: RuntimeRequestOption[] = [];
  for (const field of OPTIONAL_FIELDS) {
    if (output[field] === undefined || capabilities.request[field]) continue;
    delete output[field];
    omitted.push(field);
  }
  return Object.freeze({ ...output, omitted: Object.freeze(omitted) }) as unknown as NegotiatedRuntimeRequest;
}
