import { AntigravityCliAdapter } from '../../cli-adapters/antigravity.js';
import { ClaudeCliAdapter } from '../../cli-adapters/claude.js';
import { CodexCliAdapter } from '../../cli-adapters/codex.js';
import { DeepSeekCliAdapter } from '../../cli-adapters/deepseek.js';
import { PiCliAdapter } from '../../cli-adapters/pi.js';
import { requestCapabilities } from '../domain/capabilities.js';
import { HermesRuntime, type HermesRuntimeOptions } from '../hermes/hermes-runtime.js';
import type { RuntimeCapabilities } from '../runtime-types.js';
import { defineRuntimePlugin } from './plugin-manifest.js';
import { RuntimePluginRegistry } from './plugin-registry.js';

const persistent: RuntimeCapabilities = { protocol: 'stream-json', session: 'persistent', native_mcp: true, native_approvals: false, steering: true, cancellation: true, usage: 'tokens-and-cost', collaboration: [], skill_delivery: ['prompt', 'filesystem'] };
const oneshot = (native_mcp: boolean, usage: RuntimeCapabilities['usage']): RuntimeCapabilities => ({ protocol: 'jsonl', session: 'oneshot', native_mcp, native_approvals: false, steering: false, cancellation: true, usage, collaboration: [], skill_delivery: native_mcp ? ['prompt', 'filesystem'] : ['prompt'] });

export function createBuiltinRuntimeRegistry(): RuntimePluginRegistry {
  return new RuntimePluginRegistry()
    .register(defineRuntimePlugin({ id: 'claude', transport: 'cli', capabilities: requestCapabilities(persistent, { effort: true }), createCliAdapter: () => new ClaudeCliAdapter() }))
    .register(defineRuntimePlugin({ id: 'deepseek', transport: 'cli', capabilities: requestCapabilities({ ...persistent }), createCliAdapter: () => new DeepSeekCliAdapter() }))
    .register(defineRuntimePlugin({ id: 'codex', transport: 'cli', capabilities: requestCapabilities(oneshot(true, 'tokens'), { effort: true, streaming: true }), createCliAdapter: () => new CodexCliAdapter() }))
    .register(defineRuntimePlugin({ id: 'antigravity', transport: 'cli', capabilities: requestCapabilities(oneshot(false, 'none')), createCliAdapter: () => new AntigravityCliAdapter() }))
    .register(defineRuntimePlugin({ id: 'pi', transport: 'cli', capabilities: requestCapabilities(oneshot(true, 'tokens')), createCliAdapter: () => new PiCliAdapter() }))
    .register(defineRuntimePlugin<HermesRuntime>({ id: 'hermes', transport: 'acp', capabilities: requestCapabilities({ protocol: 'acp', session: 'resumable', native_mcp: true, native_approvals: true, steering: true, cancellation: true, usage: 'tokens', collaboration: ['delegated', 'swarm'], skill_delivery: ['filesystem', 'native'] }, { sessionId: true, streaming: true }), createOwner: options => new HermesRuntime(options as HermesRuntimeOptions) }))
    .seal();
}
