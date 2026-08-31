import { CliAdapter } from '../../../dist/lib/cli-adapters/base.js';
import { defineRuntimePlugin } from '../../../dist/lib/runtime/composition/plugin-manifest.js';
import { requestCapabilities } from '../../../dist/lib/runtime/domain/capabilities.js';

class FixtureCliAdapter extends CliAdapter {
  static cliType = 'fixture';
  resolveBin() { return 'fixture-cli'; }
  buildOneshotSpawn(spec) { return { args: ['run', spec.taskText], stdio: 'pipe' }; }
  parseStdoutLine() { return { stage: null, isResult: false, isError: false, raw: null }; }
}

const base = { protocol: 'jsonl', session: 'oneshot', native_mcp: false, native_approvals: false, steering: false, cancellation: true, usage: 'none', collaboration: [], skill_delivery: ['prompt'] };

export default defineRuntimePlugin({
  id: 'fixture',
  transport: 'cli',
  capabilities: requestCapabilities(base, { model: false, systemPrompt: false }),
  createCliAdapter: () => new FixtureCliAdapter(),
});
