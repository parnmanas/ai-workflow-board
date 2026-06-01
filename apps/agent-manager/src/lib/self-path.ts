// Resolve the absolute path to this agent-manager build at runtime, used
// when writing `mcpServers.host` entries into a managed agent's MCP config —
// the spawned CLI (claude/antigravity) needs a concrete `command + args` it can
// fork to bring up the host-mcp stdio server.
//
// Why this lives in its own module: `writeMcpConfig` (managed-agent-store)
// is shared between spawn_agent and the rehydrate path, neither of which
// should import main.ts (would create a cycle). A tiny self-contained
// helper that reads `process.argv[1]` keeps the import graph flat.
//
// Production case (the only one that matters in practice): the manager is
// installed via npm and `process.argv[1]` resolves to `dist/main.js`. Dev
// case (`tsx watch src/main.ts`): argv[1] is the .ts source — we fall back
// to `tsx` as the command since `node foo.ts` won't work. Operators
// running in dev mode and spawning managed agents need tsx on PATH; this
// is acceptable because dev mode also requires the manager to be running
// via tsx in the first place.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface SelfCommand {
  /** Executable to spawn (e.g. /usr/bin/node, /usr/bin/env). */
  command: string;
  /** First-arg arguments BEFORE any subcommand. Subcommand goes in `args`
   *  by the caller. */
  prefixArgs: string[];
  /** Resolved absolute path to the manager's main script. */
  scriptPath: string;
  /** True when the script is a TypeScript source (dev mode); false when
   *  it's the compiled dist/main.js (prod). */
  isDevSource: boolean;
}

/**
 * Returns the spawn descriptor that re-invokes this agent-manager binary.
 * Used by writeMcpConfig (host server entry) so the managed agent's CLI
 * forks the right process to bring up the host-mcp stdio server.
 */
export function resolveSelfCommand(): SelfCommand {
  // process.argv[1] is the resolved script path that node was invoked with.
  // Empty in some embedded scenarios (e.g. node REPL) but never in our
  // CLI bin context.
  const script = process.argv[1] ? resolve(process.argv[1]) : '';
  const isDevSource = script.endsWith('.ts') || script.endsWith('.tsx');

  if (!script || !existsSync(script)) {
    // Last-resort fallback: bare command name + node-runner. Will fail
    // at spawn time, but the error surfaces a clearer "binary not found"
    // than silently mis-routing the host server.
    return {
      command: 'awb-agent-manager',
      prefixArgs: [],
      scriptPath: script || '<unknown>',
      isDevSource: false,
    };
  }

  if (isDevSource) {
    // dev mode: node can't run .ts directly. tsx is the dev-time runner
    // already used by `npm run dev:agent-manager`; require it on PATH.
    return {
      command: 'tsx',
      prefixArgs: [script],
      scriptPath: script,
      isDevSource: true,
    };
  }

  // prod path: node /path/to/dist/main.js
  return {
    command: process.execPath || 'node',
    prefixArgs: [script],
    scriptPath: script,
    isDevSource: false,
  };
}
