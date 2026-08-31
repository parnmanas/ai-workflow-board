import type { CliAdapter } from '../../cli-adapters/base.js';
import { RuntimeSelectionError, type RuntimeDescriptor } from '../runtime-types.js';
import type { RuntimePluginManifest } from './plugin-manifest.js';

export class RuntimePluginRegistry {
  readonly #plugins = new Map<string, RuntimePluginManifest>();
  #sealed = false;

  register(manifest: RuntimePluginManifest): this {
    if (this.#sealed) throw new Error('Runtime plugin registry is sealed');
    const id = manifest.id.trim().toLowerCase();
    if (!id) throw new Error('Runtime plugin id is required');
    if (this.#plugins.has(id)) throw new Error(`Duplicate runtime plugin id: ${id}`);
    if (manifest.transport === 'cli' && !manifest.createCliAdapter) {
      throw new Error(`CLI runtime plugin ${id} requires createCliAdapter`);
    }
    if (manifest.transport === 'acp' && !manifest.createOwner) {
      throw new Error(`ACP runtime plugin ${id} requires createOwner`);
    }
    if (manifest.transport === 'llm' && !manifest.createLlmProvider) {
      throw new Error(`LLM 런타임 플러그인 ${id}에는 createLlmProvider가 필요합니다`);
    }
    this.#plugins.set(id, Object.freeze({ ...manifest, id }));
    return this;
  }

  seal(): this { this.#sealed = true; return this; }
  ids(): readonly string[] { return Object.freeze([...this.#plugins.keys()]); }

  manifest(runtimeId: string | null | undefined): RuntimePluginManifest {
    const id = String(runtimeId ?? '').trim().toLowerCase();
    if (!id) throw new RuntimeSelectionError('runtime_not_configured', null, 'Agent runtime is not configured');
    const plugin = this.#plugins.get(id);
    if (!plugin) throw new RuntimeSelectionError('runtime_unknown', id, `Unknown agent runtime: ${id}`);
    return plugin;
  }

  descriptor(runtimeId: string | null | undefined): RuntimeDescriptor {
    const plugin = this.manifest(runtimeId);
    const { request: _request, ...capabilities } = plugin.capabilities;
    return { id: plugin.id, capabilities };
  }

  createCliAdapter(runtimeId: string | null | undefined): CliAdapter {
    const plugin = this.manifest(runtimeId);
    if (!plugin.createCliAdapter) throw new RuntimeSelectionError('runtime_unavailable', plugin.id, `Runtime ${plugin.id} does not use a CLI adapter`);
    return plugin.createCliAdapter();
  }

  createOwner(runtimeId: string, options: unknown): unknown {
    const plugin = this.manifest(runtimeId);
    if (!plugin.createOwner) throw new RuntimeSelectionError('runtime_unavailable', plugin.id, `Runtime ${plugin.id} does not use a protocol process owner`);
    return plugin.createOwner(options);
  }

  createLlmProvider(runtimeId: string) {
    const plugin = this.manifest(runtimeId);
    if (!plugin.createLlmProvider) throw new RuntimeSelectionError('runtime_unavailable', plugin.id, `런타임 ${plugin.id}은 LLM provider를 사용하지 않습니다`);
    return plugin.createLlmProvider();
  }
}
