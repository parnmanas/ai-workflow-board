# Codex AWB Native MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Agent Manager-managed Codex runs load and directly use AWB's required Streamable HTTP MCP server.

**Architecture:** The Codex adapter will materialize an agent-owned `config.toml` with managed AWB and host MCP tables, using `AWB_API_KEY` as Codex's bearer-token environment variable. Codex becomes a native-MCP one-shot adapter, while per-dispatch ticket/role headers are passed through argv config overrides and refresh/rehydrate reuse the same preparation path.

**Tech Stack:** TypeScript 5.6, Node.js 22, Codex CLI MCP configuration, `smol-toml` 1.7, Node test runner, npm workspaces/Turbo.

## Global Constraints

- Keep NestJS, React, TypeORM, and the existing Streamable HTTP `/mcp` contract unchanged.
- AWB MCP is `required = true`; host MCP remains optional.
- Never write the raw AWB API key into Codex `config.toml` or logs.
- Never mutate an operator-global `config.toml` through a symlink.
- Preserve unrelated Codex settings and MCP servers semantically.
- Do not bump the companion stdio plugin because the server MCP surface is unchanged.
- Any `apps/agent-manager/src` change requires Agent Manager build, root Turbo build, package version bump, commit, and push.

---

### Task 1: Codex-native MCP configuration

**Files:**
- Create: `apps/agent-manager/test/codex-adapter.test.mjs`
- Modify: `apps/agent-manager/src/lib/cli-adapters/codex.ts`
- Modify: `apps/agent-manager/package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: `AdapterMcpContext`, `resolveSelfCommand()`, `AWB_API_KEY` already injected by the spawn site.
- Produces: `CodexCliAdapter.prepareCliHome(cliHomeDir, credential, mcp)` that writes an agent-local `config.toml` containing `mcp_servers.awb` and `mcp_servers.host`.

- [ ] **Step 1: Write failing adapter tests**

  Test a fresh home, existing settings/MCP preservation, idempotent URL refresh, raw-key absence, `required=true`, invalid TOML rejection, and symlink target preservation. Parse output with `smol-toml` and assert:

  ```js
  assert.equal(config.mcp_servers.awb.bearer_token_env_var, 'AWB_API_KEY');
  assert.equal(config.mcp_servers.awb.required, true);
  assert.ok(!written.includes('sk-agent-123'));
  assert.equal(config.mcp_servers.existing.command, '/bin/existing');
  assert.equal((await fsp.lstat(configPath)).isSymbolicLink(), false);
  assert.equal(await fsp.readFile(operatorConfig, 'utf8'), originalOperatorText);
  ```

- [ ] **Step 2: Run the focused test and verify RED**

  Run: `npm run build -w agent-manager; node --test apps/agent-manager/test/codex-adapter.test.mjs`

  Expected: FAIL because Codex does not write native MCP config and does not expose native capability.

- [ ] **Step 3: Add TOML runtime support and implement the merge**

  Add `"smol-toml": "^1.7.0"`. In `prepareCliHome`, obtain the credential-specific or inherited config text, parse before mutation, set:

  ```ts
  config.mcp_servers.awb = {
    url: `${mcp.url.replace(/\/$/, '')}/mcp`,
    bearer_token_env_var: 'AWB_API_KEY',
    http_headers: { 'X-AWB-Client-Type': 'managed-subagent' },
    required: true,
  };
  config.mcp_servers.host = {
    command: self.command,
    args: [...self.prefixArgs, 'mcp-host'],
  };
  ```

  Unlink a destination symlink before writing the serialized config as an agent-owned `0600` regular file. Preserve auth behavior for subscription, API-key, and operator-home modes.

- [ ] **Step 4: Run the focused test and verify GREEN**

  Run: `npm run build -w agent-manager; node --test apps/agent-manager/test/codex-adapter.test.mjs`

  Expected: all Codex adapter tests PASS.

- [ ] **Step 5: Commit the configuration unit**

  ```bash
  git add apps/agent-manager/src/lib/cli-adapters/codex.ts apps/agent-manager/test/codex-adapter.test.mjs apps/agent-manager/package.json package-lock.json
  git commit -m "fix(agent-manager): load AWB MCP in managed Codex"
  ```

### Task 2: Native behavior and per-run attribution

**Files:**
- Modify: `apps/agent-manager/src/lib/cli-adapters/base.ts`
- Modify: `apps/agent-manager/src/lib/cli-adapters/codex.ts`
- Modify: `apps/agent-manager/src/lib/subagent-manager.ts`
- Modify: `apps/agent-manager/test/codex-adapter.test.mjs`
- Modify: `apps/agent-manager/test/chat-prompt-native-mcp.test.mjs`

**Interfaces:**
- Produces: `McpAttribution` with optional `ticketId`, `role`, and `triggerSource`; `OneshotSpec.mcpAttribution?: McpAttribution`.
- Consumes: existing `SubagentSpawnArgs.ticketId`, `.role`, and `.triggerSource`.

- [ ] **Step 1: Write failing capability and argv tests**

  Assert Codex has `NATIVE_MCP` but not `PERSISTENT_SESSION`. Build a spawn with attribution and assert the `-c` value parses as TOML and contains the managed-client, ticket, role, and trigger headers. Build a chat spawn without attribution and assert no per-run header override is emitted. Update the prompt regression expectation so Codex selects the native MCP reply path.

- [ ] **Step 2: Run focused tests and verify RED**

  Run: `npm run build -w agent-manager; node --test apps/agent-manager/test/codex-adapter.test.mjs apps/agent-manager/test/chat-prompt-native-mcp.test.mjs`

  Expected: FAIL because Codex is non-native and ignores attribution.

- [ ] **Step 3: Implement native capability and attribution override**

  Add `McpAttribution`, pass it from both `buildOneshotSpawn()` calls in `SubagentManager`, and generate one argv pair with a focused helper that serializes an inline TOML string map:

  ```ts
  function inlineTomlStringMap(values: Record<string, string>): string {
    return `{ ${Object.entries(values)
      .map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`)
      .join(', ')} }`;
  }

  ['-c', `mcp_servers.awb.http_headers=${inlineTomlStringMap(headers)}`]
  ```

  The header map always includes `X-AWB-Client-Type`; optional values are included only when non-empty. Keep `needsMcpConfig: false` because Codex does not consume Claude JSON configs.

- [ ] **Step 4: Run focused tests and verify GREEN**

  Run: `npm run build -w agent-manager; node --test apps/agent-manager/test/codex-adapter.test.mjs apps/agent-manager/test/chat-prompt-native-mcp.test.mjs`

  Expected: all focused tests PASS and native prompt selection prevents manager stdout reply instructions.

- [ ] **Step 5: Commit the behavior unit**

  ```bash
  git add apps/agent-manager/src/lib/cli-adapters/base.ts apps/agent-manager/src/lib/cli-adapters/codex.ts apps/agent-manager/src/lib/subagent-manager.ts apps/agent-manager/test/codex-adapter.test.mjs apps/agent-manager/test/chat-prompt-native-mcp.test.mjs
  git commit -m "fix(agent-manager): use Codex native MCP replies"
  ```

### Task 3: Refresh lifecycle and release

**Files:**
- Modify: `apps/agent-manager/src/lib/agent-manager-commands.ts`
- Create: `apps/agent-manager/test/agent-manager-commands.test.mjs`
- Modify: `apps/agent-manager/README.md`
- Modify: `docs/agent-manager.md`
- Modify: `apps/agent-manager/package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: `contextRegistry.get(agentId)` and adapter `prepareCliHome()`.
- Produces: `refresh_mcp_config` refreshes both manager JSON and Codex-native config.

- [ ] **Step 1: Write a failing refresh regression test**

  Register a Codex context with a temporary cli-home, invoke `refresh_mcp_config`, and assert `config.toml` receives the current AWB URL while the API key remains outside the TOML.

- [ ] **Step 2: Run the command test and verify RED**

  Run the single command-handler test through Node's test runner after `npm run build -w agent-manager`.

  Expected: FAIL because refresh only rewrites manager `mcp-config.json`.

- [ ] **Step 3: Reuse adapter preparation from refresh**

  After `writeMcpConfig`, resolve the registered context and call:

  ```ts
  await createAdapter(ctx.cli).prepareCliHome(
    ctx.cli_home_dir,
    await readAgentCredential(agentId),
    { url: this.#config.url, apiKey: rawApiKey },
    ctx.model ?? null,
  );
  ```

  Update docs to state that Codex agents use native `config.toml`, AWB is required, and restart/refresh repairs existing agents.

- [ ] **Step 4: Run full verification**

  Run:

  ```bash
  npm test -w agent-manager
  npm run build
  ```

  Expected: agent-manager tests PASS and root Turbo build exits 0.

- [ ] **Step 5: Validate against the installed Codex CLI**

  Create a temporary `CODEX_HOME` using the adapter output, supply a placeholder `AWB_API_KEY`, and run `codex mcp list`. Expected: `awb` is listed as enabled and required; `host` is listed without exposing the key.

- [ ] **Step 6: Bump and verify the Agent Manager release version**

  Bump `apps/agent-manager/package.json` from `1.6.17` to `1.6.18`, synchronize `package-lock.json`, rerun `npm run build -w agent-manager` and `npm run build`, and confirm no server MCP schema file changed.

- [ ] **Step 7: Commit release changes**

  ```bash
  git add apps/agent-manager README.md docs package-lock.json
  git commit -m "chore(agent-manager): release 1.6.18"
  ```

### Task 4: Integrate and publish

**Files:** none beyond prior tasks.

**Interfaces:** Produces a clean `main` at the verified release commit and removes the temporary feature branch/worktree.

- [ ] **Step 1: Verify feature branch state**

  Run `git status --short`, `git log --oneline main..HEAD`, and the full build/test commands. Expected: clean tree and all checks passing.

- [ ] **Step 2: Merge into main**

  In the primary checkout, fast-forward `main` to the feature branch. Re-run `npm test -w agent-manager` and `npm run build` on `main`.

- [ ] **Step 3: Push main and clean isolation**

  Run `git push origin main`, remove the linked worktree, delete the local feature branch, prune worktree metadata, and verify `main...origin/main` is `0 0` with a clean tree.
