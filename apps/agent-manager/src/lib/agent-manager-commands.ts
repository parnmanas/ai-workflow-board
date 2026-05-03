// ST-5b — handle agent_manager_command SSE events.
//
// Event shape (from server, see common/types/stream-events on AWB):
//   {
//     command_id:   string,
//     instance_id:  string,            // target manager instance
//     agent_id:     string,            // server fills with the MANAGER'S identity
//                                      // (NOT the target managed agent — see below)
//     command:      'spawn_agent' | 'stop_agent' | 'restart_agent'
//                 | 'set_working_dir' | 'reload_config',
//     args:         Record<string, any>,   // command-specific (e.g. { working_dir })
//     issued_by:    string,            // user id of the admin
//     issued_at:    string,
//     timestamp:    string,
//   }
//
// agent_id semantics (load-bearing): the server-emitted top-level `agent_id`
// is the *manager* instance's identity (used for SSE fan-out scoping).
// The actual *target managed agent* always travels in `args.agent_id`.
// Earlier revisions used `args.agent_id ?? agent_id` which silently picked
// the manager itself as the target when args was malformed; that fallback
// is now removed and the per-command extractor below requires args.agent_id.
//
// Filtering: every manager subscribed to the SSE stream sees every command
// payload (the server fans out per-agent). We drop events whose
// `instance_id` doesn't match this process — that's how multiple manager
// instances sharing one Agent identity stay segregated.
//
// Acks: every command (success or stub) hits POST /api/agent-manager/command/ack
// so the server log surfaces the outcome to the operator.

import { log } from './logging.js';
import {
  postCommandAck,
  fetchAgentRecord,
  fetchAgentCredential,
  provisionManagedAgentApiKey,
  type AwbConfig,
} from './rest.js';
import type { ManagedAgentRegistry } from './managed-agents.js';
import type { ManagedAgentContextRegistry } from './managed-agent-context.js';
import {
  ensureManagedAgentDir,
  readApiKey,
  writeApiKey,
  writeMcpConfig,
  writeManagedAgentConfig,
  writeAgentCredential,
  eraseAgentCredential,
  type ManagedAgentCredential,
  mcpConfigPathFor,
  subagentLogPathFor,
  cliHomeDirFor,
  ensureCliHomeDir,
  eraseSecrets,
  maskKey,
} from './managed-agent-store.js';
import { createAdapter } from './cli-adapters/index.js';

type CommandKind =
  | 'spawn_agent'
  | 'stop_agent'
  | 'restart_agent'
  | 'set_working_dir'
  | 'reload_config'
  | 'update_plugins'
  | 'refresh_mcp_config'
  | 'pull_working_dir';

const KNOWN_COMMANDS: ReadonlySet<CommandKind> = new Set<CommandKind>([
  'spawn_agent',
  'stop_agent',
  'restart_agent',
  'set_working_dir',
  'reload_config',
  'update_plugins',
  'refresh_mcp_config',
  'pull_working_dir',
]);

export interface AgentManagerCommandPayload {
  command_id: string;
  instance_id: string;
  agent_id?: string;
  command: CommandKind | string;
  args?: Record<string, any>;
  issued_by?: string;
  issued_at?: string;
  timestamp?: string;
}

export interface CommandHandlerDeps {
  /** Function returning the heartbeating instance id at call time (it's
   * created lazily after pairing, so we can't capture it in the constructor). */
  getInstanceId(): string | null;
  /** ManagedAgentRegistry — populated by the handler. */
  registry: ManagedAgentRegistry;
  /** ST-6: per-agent runtime context registry (cwd / apiKey / mcp-config).
   * Optional so legacy harnesses without multi-tenant routing keep working. */
  contextRegistry?: ManagedAgentContextRegistry | null;
  /** Optional config-reload hook; resolves with a short summary string. */
  reloadConfig?: () => Promise<string> | string;
}

export class AgentManagerCommandHandler {
  #config: AwbConfig;
  #deps: CommandHandlerDeps;

  constructor(config: AwbConfig, deps: CommandHandlerDeps) {
    this.#config = config;
    this.#deps = deps;
  }

  /**
   * Entry point. Parses the raw SSE data, drops mis-targeted events, and
   * routes to the per-command branch. Always acks (ok|error) so the server
   * audit isn't left guessing.
   */
  async handle(raw: string): Promise<void> {
    let payload: AgentManagerCommandPayload;
    try {
      payload = JSON.parse(raw);
    } catch (err: any) {
      log(`agent_manager_command: parse failed: ${err?.message ?? err}`);
      return;
    }

    if (!payload?.command_id) {
      log('agent_manager_command: missing command_id — dropped');
      return;
    }

    const myInstanceId = this.#deps.getInstanceId();
    if (myInstanceId && payload.instance_id && payload.instance_id !== myInstanceId) {
      // Different manager process on the same agent identity — silently drop.
      return;
    }

    const command = String(payload.command || '') as CommandKind;
    if (!KNOWN_COMMANDS.has(command)) {
      log(`agent_manager_command: unknown command "${command}" id=${payload.command_id}`);
      await postCommandAck(this.#config, payload.command_id, 'error', `unknown command: ${command}`);
      return;
    }

    try {
      const result = await this.#dispatch(command, payload);
      await postCommandAck(this.#config, payload.command_id, 'ok', result);
      log(`agent_manager_command ${command} id=${payload.command_id} → ${result}`);
    } catch (err: any) {
      const detail = err?.message ?? String(err);
      log(`agent_manager_command ${command} id=${payload.command_id} FAILED: ${detail}`);
      await postCommandAck(this.#config, payload.command_id, 'error', detail);
    }
  }

  async #dispatch(command: CommandKind, payload: AgentManagerCommandPayload): Promise<string> {
    switch (command) {
      case 'spawn_agent':
        return this.#spawnAgent(payload);
      case 'stop_agent':
        return this.#stopAgent(payload);
      case 'restart_agent':
        return this.#restartAgent(payload);
      case 'set_working_dir':
        return this.#setWorkingDir(payload);
      case 'reload_config':
        return this.#reloadConfig();
      case 'update_plugins':
        return this.#updatePlugins(payload);
      case 'refresh_mcp_config':
        return this.#refreshMcpConfig(payload);
      case 'pull_working_dir':
        return this.#pullWorkingDir(payload);
    }
  }

  /**
   * Pull the target managed-agent id from `args.agent_id`. The top-level
   * `payload.agent_id` is the manager's own identity (server fan-out
   * scoping) and is intentionally NOT used as a fallback — falling back to
   * it would let a malformed dispatch act on the manager itself.
   */
  #targetAgentId(payload: AgentManagerCommandPayload, command: string): string {
    const id = typeof payload.args?.agent_id === 'string' ? payload.args.agent_id.trim() : '';
    if (!id) throw new Error(`${command}: args.agent_id is required`);
    return id;
  }

  /**
   * ST-6: Real bootstrap for a managed agent.
   *
   * Steps (idempotent):
   *   1. Hydrate canonical record from AWB (cli + working_dir).
   *   2. Ensure on-disk dir at <MANAGER_HOME>/agents/<id>/.
   *   3. Cache record into config.json.
   *   4. Provision (or reuse on-disk) apiKey + write the agent's
   *      mcp-config.json with that apiKey embedded.
   *   5. Register a runtime context so EventDispatcher can route to it.
   *   6. Mark status='running' in the heartbeat registry.
   *
   * No long-lived child process: subagents are forked per event with this
   * context as their cwd / apiKey. spawn_agent is therefore a "register +
   * provision" step, not a process fork. Stop = drop context + mark
   * stopped; in-flight subagents already running are NOT killed (they hold
   * a snapshot of the apiKey/cwd they were spawned with).
   */
  async #spawnAgent(payload: AgentManagerCommandPayload): Promise<string> {
    const agentId = this.#targetAgentId(payload, 'spawn_agent');

    // Pull the canonical record from AWB so we know the cli / working_dir
    // the admin configured. Falls back to in-payload args when present.
    const remote = await fetchAgentRecord(this.#config, agentId);
    const name = remote?.name ?? payload.args?.name ?? agentId.slice(0, 8);
    const cli = remote?.type ?? payload.args?.cli ?? 'claude';
    const workingDir = remote?.working_dir || payload.args?.working_dir || '';

    if (!workingDir) {
      throw new Error('spawn_agent: working_dir is empty — set it before spawning');
    }

    const rec = this.#deps.registry.upsert({ agent_id: agentId, name, cli, working_dir: workingDir });
    rec.status = 'spawning';

    // 2. on-disk dir + 3. cached settings
    await ensureManagedAgentDir(agentId);
    await writeManagedAgentConfig({
      agent_id: agentId,
      name,
      cli,
      working_dir: workingDir,
      workspace_id: (remote as any)?.workspace_id || '',
      last_spawn_at: new Date().toISOString(),
    });

    // 4. apiKey: reuse on-disk if present (faster + avoids unnecessary
    // rotation); else provision a fresh one. The server's provision
    // endpoint is idempotent in the "rotate any prior provisioned" sense,
    // so a fresh provision here is also safe — we just don't gratuitously
    // rotate every spawn_agent (e.g. on a manager restart).
    let rawApiKey = await readApiKey(agentId);
    let provisioned = false;
    if (!rawApiKey) {
      const issued = await provisionManagedAgentApiKey(this.#config, agentId);
      if (!issued?.raw_key) {
        throw new Error('spawn_agent: apiKey provisioning failed (server returned no key)');
      }
      rawApiKey = issued.raw_key;
      await writeApiKey(agentId, rawApiKey);
      provisioned = true;
    }
    const mcpConfigPath = await writeMcpConfig(agentId, this.#config.url, rawApiKey);

    // ST-7 follow-up: per-agent CLI home dir. Created lazily here so the
    // CLI (claude/codex/gemini) writes its sessions / plugins / settings
    // into a dir scoped to this agent rather than ~/.<cli>/ on the
    // shared host.
    await ensureCliHomeDir(agentId);
    const cliHomeDir = cliHomeDirFor(agentId);

    // Per-agent CLI credential — fetch from AWB (paid via the manager's
    // apiKey, server enforces ownership). Three outcomes:
    //   - server returns 204 (no credential set) → null, fall back to
    //     legacy operator-HOME symlink path
    //   - server returns the decrypted payload → write it to disk for
    //     rehydrate and apply via the adapter
    //   - any error → null, log + fall back (the CLI's own auth error
    //     is more actionable than blocking spawn here)
    // Provider must match the agent's CLI (e.g. claude_subscription on a
    // claude agent); a mismatch is logged and ignored so a typo on the
    // AWB side doesn't silently start sending OpenAI keys to claude.
    const credentialIdHint = typeof payload.args?.credential_id === 'string' ? payload.args.credential_id : '';
    const credential = await this.#resolveAgentCredential(agentId, cli, credentialIdHint);
    if (credential) {
      await writeAgentCredential(agentId, credential);
    } else {
      await eraseAgentCredential(agentId);
    }

    // Adapter-specific cli-home bootstrap — typically credential
    // propagation so the spawned CLI doesn't immediately fail with an
    // auth error on a fresh per-agent home (claude reads
    // .credentials.json from CLAUDE_CONFIG_DIR; without this hook the
    // first turn exited with is_error=true in well under a second).
    // Best-effort: a propagation failure is logged but doesn't block
    // spawn — the CLI's own auth error is more actionable than a
    // missing-file abort here.
    let extraEnv: Record<string, string> = {};
    try {
      const prep = await createAdapter(cli).prepareCliHome(cliHomeDir, credential);
      extraEnv = prep?.extraEnv ?? {};
    } catch (err: any) {
      log(`spawn_agent: cli-home prep failed for agent=${agentId.slice(0, 8)} cli=${cli}: ${err?.message ?? err}`);
    }

    // 5. context registry — EventDispatcher reads this on every event
    if (this.#deps.contextRegistry) {
      this.#deps.contextRegistry.upsert({
        agent_id: agentId,
        name,
        cli,
        working_dir: workingDir,
        mcp_config_path: mcpConfigPath,
        api_key: rawApiKey,
        subagent_log_path: subagentLogPathFor(agentId),
        cli_home_dir: cliHomeDir,
        extra_env: extraEnv,
        registered_at: new Date().toISOString(),
      });
    }

    // 6. mark running. pid=process.pid means "managed by THIS manager";
    // there's no per-agent permanent process to track, but the heartbeat
    // surface still wants a live pid for the dashboard.
    this.#deps.registry.markRunning(agentId, process.pid);

    const credentialNote = credential ? ` credential=${credential.provider}` : ' credential=none';
    log(
      `spawn_agent: agent=${agentId.slice(0, 8)} name=${name} cli=${cli} cwd=${workingDir}` +
        ` apiKey=${maskKey(rawApiKey)}${provisioned ? ' (provisioned)' : ' (reused)'}${credentialNote}`,
    );
    return (
      `spawn_agent ok: agent=${agentId.slice(0, 8)} cli=${cli} cwd=${workingDir}` +
      ` apiKey=${provisioned ? 'provisioned' : 'reused'}${credentialNote}`
    );
  }

  /**
   * Pull the per-agent CLI credential from AWB and validate that its
   * provider prefix matches the agent's CLI (e.g. `claude_subscription` on
   * a claude agent). Returns null when AWB has none configured, when the
   * fetch fails, or when the provider doesn't match — caller falls back to
   * legacy operator-HOME credential propagation.
   *
   * `credentialIdHint` is the credential_id the server enriched the spawn
   * payload with at dispatch time; we use it for diagnostic logging only —
   * the manager never trusts client-supplied credential payloads, only
   * what the server returns over its authenticated REST endpoint.
   */
  async #resolveAgentCredential(
    agentId: string,
    cli: string,
    credentialIdHint: string,
  ): Promise<ManagedAgentCredential | null> {
    const fetched = await fetchAgentCredential(this.#config, agentId);
    if (!fetched) {
      if (credentialIdHint) {
        log(
          `spawn_agent: agent=${agentId.slice(0, 8)} expected credential=${credentialIdHint.slice(0, 8)} but server returned none`,
        );
      }
      return null;
    }
    const expectedPrefix = `${cli}_`;
    if (!fetched.provider.startsWith(expectedPrefix)) {
      log(
        `spawn_agent: agent=${agentId.slice(0, 8)} credential provider=${fetched.provider}` +
          ` does not match cli=${cli}; ignoring`,
      );
      return null;
    }
    return {
      credential_id: fetched.credential_id,
      provider: fetched.provider,
      fields: fetched.fields,
    };
  }

  async #stopAgent(payload: AgentManagerCommandPayload): Promise<string> {
    const agentId = this.#targetAgentId(payload, 'stop_agent');
    const hadContext = this.#deps.contextRegistry?.delete(agentId) ?? false;
    const rec = this.#deps.registry.markStopped(agentId, 'stop_agent command');
    // Erase on-disk secrets so the next spawn_agent re-provisions a fresh
    // key. This is the expected security posture: an admin stopping an
    // agent invalidates its credentials on the next start.
    await eraseSecrets(agentId).catch(() => undefined);
    if (!rec && !hadContext) {
      // Unknown to this manager — likely never spawned here. Treat as a
      // no-op success so the operator's ack reflects "nothing to do".
      return `stop_agent: agent=${agentId.slice(0, 8)} not running on this manager`;
    }
    return `stop_agent ok: agent=${agentId.slice(0, 8)} (context dropped, secrets erased)`;
  }

  async #restartAgent(payload: AgentManagerCommandPayload): Promise<string> {
    // Asserts args.agent_id once up front — both inner calls reuse it via payload.
    this.#targetAgentId(payload, 'restart_agent');
    await this.#stopAgent(payload).catch(() => undefined);
    const detail = await this.#spawnAgent(payload);
    return `restart_agent → ${detail}`;
  }

  async #setWorkingDir(payload: AgentManagerCommandPayload): Promise<string> {
    const agentId = this.#targetAgentId(payload, 'set_working_dir');
    const workingDir = String(payload.args?.working_dir ?? '').trim();
    if (!workingDir) throw new Error('set_working_dir: working_dir is empty');

    // If we don't yet know about the agent, hydrate from AWB so we capture
    // its name/cli; that way the next heartbeat reports a sensible record.
    if (!this.#deps.registry.get(agentId)) {
      const remote = await fetchAgentRecord(this.#config, agentId);
      this.#deps.registry.upsert({
        agent_id: agentId,
        name: remote?.name ?? agentId.slice(0, 8),
        cli: remote?.type ?? 'claude',
        working_dir: workingDir,
      });
    } else {
      this.#deps.registry.setWorkingDir(agentId, workingDir);
    }
    return `set_working_dir: agent=${agentId.slice(0, 8)} cwd=${workingDir}`;
  }

  async #reloadConfig(): Promise<string> {
    const hook = this.#deps.reloadConfig;
    if (!hook) return 'reload_config: no reload hook wired (no-op)';
    const summary = await hook();
    return `reload_config: ${summary || 'reloaded'}`;
  }

  /**
   * Refresh the on-disk mcp-config.json for a managed agent so spawned
   * subagents pick up the current AWB url + the agent's existing apiKey.
   * Idempotent: if the file is already up-to-date the rewrite is a no-op for
   * downstream consumers (claude reads it on each spawn). The apiKey is NOT
   * rotated — for a fresh provision use stop_agent + spawn_agent. Use cases:
   *   - operator changed the AWB server's public URL (e.g., domain rename)
   *   - upgraded the manager and the mcp-config schema needs a rewrite
   */
  async #refreshMcpConfig(payload: AgentManagerCommandPayload): Promise<string> {
    const agentId = this.#targetAgentId(payload, 'refresh_mcp_config');
    const rawApiKey = await readApiKey(agentId);
    if (!rawApiKey) {
      throw new Error(
        `refresh_mcp_config: no apiKey on disk for agent=${agentId.slice(0, 8)} ` +
          `(spawn_agent first to provision)`,
      );
    }
    const path = await writeMcpConfig(agentId, this.#config.url, rawApiKey);
    return `refresh_mcp_config ok: agent=${agentId.slice(0, 8)} path=${path}`;
  }

  /**
   * Update claude plugin marketplaces in the managed agent's cli-home. Each
   * marketplace under `<cli-home>/plugins/marketplaces/<id>/` is a git
   * checkout of the marketplace repo, so a `git pull --ff-only` in that dir
   * is the cheapest way to refresh the plugin source without restarting the
   * agent. Implementation:
   *   - List `<cli-home>/plugins/marketplaces/` (silently skip if missing).
   *   - For each entry that is a git repo, run `git pull --ff-only`. Failures
   *     are collected per-entry and reported back; a single failed
   *     marketplace doesn't block the others.
   *   - For non-claude managed agents (codex/gemini), the dir layout doesn't
   *     match — return a "not applicable" success rather than fail loudly.
   */
  async #updatePlugins(payload: AgentManagerCommandPayload): Promise<string> {
    const agentId = this.#targetAgentId(payload, 'update_plugins');
    const ctx = this.#deps.contextRegistry?.get(agentId);
    if (!ctx) {
      throw new Error(
        `update_plugins: agent=${agentId.slice(0, 8)} is not registered ` +
          `(spawn_agent first so the manager owns its cli-home)`,
      );
    }
    if (ctx.cli !== 'claude') {
      return `update_plugins: agent=${agentId.slice(0, 8)} cli=${ctx.cli} (not applicable — claude only)`;
    }
    const result = await runPluginUpdate(ctx.cli_home_dir);
    return (
      `update_plugins ok: agent=${agentId.slice(0, 8)} updated=${result.updated} ` +
      `skipped=${result.skipped} failed=${result.failed}` +
      (result.failed > 0 ? ` — first error: ${result.errors[0] || '(none)'}` : '')
    );
  }

  /**
   * Best-effort `git -C <agent.working_dir> pull --ff-only` — useful when an
   * operator wants the managed agent's repo brought up to date before the
   * next ticket lands. The manager owns the working_dir for cwd routing but
   * is otherwise hands-off; a long-running git operation here can stall the
   * dispatch loop, so the call is bounded by a short timeout. Working_dir is
   * taken from args.working_dir (server-enriched from Agent.working_dir).
   */
  async #pullWorkingDir(payload: AgentManagerCommandPayload): Promise<string> {
    const agentId = this.#targetAgentId(payload, 'pull_working_dir');
    const workingDir = String(payload.args?.working_dir ?? '').trim();
    if (!workingDir) {
      throw new Error('pull_working_dir: working_dir is required (server should enrich it)');
    }
    const result = await runGitPull(workingDir);
    if (!result.ok) {
      throw new Error(
        `pull_working_dir failed: agent=${agentId.slice(0, 8)} cwd=${workingDir} — ${result.detail}`,
      );
    }
    return `pull_working_dir ok: agent=${agentId.slice(0, 8)} cwd=${workingDir} — ${result.detail}`;
  }
}

// ─── helpers (kept module-scoped to avoid bloating the class API) ───────

/**
 * Run `git pull --ff-only` for every git checkout under
 * `<cli-home>/plugins/marketplaces/`. Returns counts so the caller can
 * report a single line summary. Per-marketplace errors don't fail the
 * batch — they're collected for the caller to surface.
 */
async function runPluginUpdate(
  cliHomeDir: string,
): Promise<{ updated: number; skipped: number; failed: number; errors: string[] }> {
  const { promises: fsp, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const marketplacesDir = join(cliHomeDir, 'plugins', 'marketplaces');
  if (!existsSync(marketplacesDir)) {
    return { updated: 0, skipped: 0, failed: 0, errors: [] };
  }
  let entries: string[];
  try {
    entries = await fsp.readdir(marketplacesDir);
  } catch (err: any) {
    return { updated: 0, skipped: 0, failed: 1, errors: [err?.message ?? String(err)] };
  }
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const name of entries) {
    const dir = join(marketplacesDir, name);
    try {
      const stat = await fsp.stat(dir);
      if (!stat.isDirectory()) {
        skipped++;
        continue;
      }
    } catch {
      skipped++;
      continue;
    }
    if (!existsSync(join(dir, '.git'))) {
      skipped++;
      continue;
    }
    const res = await runGitPull(dir);
    if (res.ok) {
      updated++;
    } else {
      failed++;
      errors.push(`${name}: ${res.detail}`);
    }
  }
  return { updated, skipped, failed, errors };
}

/**
 * Run `git pull --ff-only` in a single directory with a hard 30s timeout.
 * Returns ok=false with detail on any failure (not-a-repo, network, conflict,
 * timeout) so callers can decide whether to throw or aggregate. Stderr is
 * preferred over stdout for the detail line because git's interesting
 * failure messages land there.
 */
async function runGitPull(
  dir: string,
): Promise<{ ok: boolean; detail: string }> {
  const { spawn } = await import('node:child_process');
  const { existsSync } = await import('node:fs');
  if (!existsSync(dir)) {
    return { ok: false, detail: `directory does not exist: ${dir}` };
  }
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', dir, 'pull', '--ff-only'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve({ ok: false, detail: 'timeout after 30s' });
    }, 30_000);
    child.stdout?.on('data', (b) => {
      stdout += String(b);
    });
    child.stderr?.on('data', (b) => {
      stderr += String(b);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, detail: `spawn failed: ${err?.message ?? err}` });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const lastLine = (stderr.trim() || stdout.trim()).split('\n').filter(Boolean).pop() || '';
      if (code === 0) {
        resolve({ ok: true, detail: lastLine.slice(0, 200) || 'up-to-date' });
      } else {
        resolve({
          ok: false,
          detail: `exit=${code} ${lastLine.slice(0, 200) || '(no output)'}`,
        });
      }
    });
  });
}
