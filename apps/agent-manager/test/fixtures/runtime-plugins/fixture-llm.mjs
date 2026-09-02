import { defineRuntimePlugin } from '../../../dist/lib/runtime/composition/plugin-manifest.js';
import { requestCapabilities } from '../../../dist/lib/runtime/domain/capabilities.js';

const capabilities = {
  protocol: 'jsonl', session: 'oneshot', native_mcp: false, native_approvals: false,
  steering: false, cancellation: true, usage: 'tokens', collaboration: [], skill_delivery: ['prompt'],
};

export default defineRuntimePlugin({
  id: 'fixture-llm',
  transport: 'llm',
  capabilities: requestCapabilities(capabilities, { systemPrompt: false }),
  createLlmProvider: () => ({
    complete: async request => ({ text: JSON.stringify(request), usage: { input: request.prompt.length } }),
  }),
});
