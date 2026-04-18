/**
 * `registerAllTools` orchestrator — called by both the NestJS integrated
 * controller (mcp.controller.ts) and the standalone entry point
 * (mcp-server.ts).
 *
 * Tools are discovered by scanning this directory for `*-tools.{ts,js}`
 * files at startup. Each tool file MUST export a function named
 * `register<Domain>Tools(server, ctx)` — the loader picks it up by
 * convention. Adding a new tool domain is a single drop-in: create
 * `foo-tools.ts`, export `registerFooTools`, done. No edits here needed.
 *
 * Rationale: the prior hand-maintained import/call list grew to 14 lines
 * and had to be edited in lockstep whenever a new domain landed. The
 * registry indirection removes that coupling and reduces the likelihood
 * of "I added the file but forgot to wire it" bugs.
 */

import { readdirSync } from 'fs';
import { join } from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { setEmbeddingDataSource } from '../../../services/embedding.service';
import { setGitHubDataSource } from '../../../services/github-connector.service';
import type { ToolContext } from './context';

export type { ToolContext } from './context';
export { createStandaloneContext } from './context';

type RegisterFn = (server: McpServer, ctx: ToolContext) => void;

interface DiscoveredModule {
  domain: string;
  register: RegisterFn;
}

/**
 * Scan __dirname for `<domain>-tools.{ts,js}` files and resolve their
 * `register<Domain>Tools` exports. Sorted for deterministic order —
 * filesystem enumeration order is not guaranteed.
 *
 * Both .ts (dev via tsx) and .js (prod compiled) are present depending on
 * runtime; dedupe by basename so we never require the same module twice.
 */
function discoverToolModules(): DiscoveredModule[] {
  const entries = readdirSync(__dirname);
  const bases = new Set<string>();
  for (const f of entries) {
    const m = /^(.+-tools)\.(ts|js)$/.exec(f);
    if (!m) continue;
    if (f.endsWith('.d.ts')) continue;
    bases.add(m[1]);
  }

  const modules: DiscoveredModule[] = [];
  for (const base of Array.from(bases).sort()) {
    const mod: Record<string, unknown> = require(join(__dirname, base));
    const register = findRegisterFn(mod, base);
    if (!register) {
      throw new Error(
        `[mcp/tools] ${base} does not export a register*Tools function. ` +
          `Expected something like \`export function registerFooTools(server, ctx)\`.`,
      );
    }
    modules.push({ domain: base.replace(/-tools$/, ''), register });
  }
  return modules;
}

function findRegisterFn(mod: Record<string, unknown>, base: string): RegisterFn | null {
  // Convention: exactly one export matching /^register[A-Z].*Tools$/.
  for (const [name, value] of Object.entries(mod)) {
    if (typeof value === 'function' && /^register[A-Z].*Tools$/.test(name)) {
      return value as RegisterFn;
    }
  }
  return null;
}

export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  // Hydrate the DataSource-aware services that are still accessed via
  // module setters (embedding / github). Safe to call on every server
  // creation — both setters are idempotent.
  setEmbeddingDataSource(ctx.dataSource);
  setGitHubDataSource(ctx.dataSource);

  for (const mod of discoverToolModules()) {
    mod.register(server, ctx);
  }
}
