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
  mcpConfigPathFor,
  subagentLogPathFor,
  eraseSecrets,
  maskKey,
} from './managed-agent-store.js';

type CommandKind =
  | 'spawn_agent'
  | 'stop_agent'
  | 'restart_agent'
  | 'set_working_dir'
  | 'reload_config';

const KNOWN_COMMANDS: ReadonlySet<CommandKind> = new Set<CommandKind>([
  'spawn_agent',
  'stop_agent',
  'restart_agent',
  'set_working_dir',
  'reload_config',
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
        registered_at: new Date().toISOString(),
      });
    }

    // 6. mark running. pid=process.pid means "managed by THIS manager";
    // there's no per-agent permanent process to track, but the heartbeat
    // surface still wants a live pid for the dashboard.
    this.#deps.registry.markRunning(agentId, process.pid);

    log(
      `spawn_agent: agent=${agentId.slice(0, 8)} name=${name} cli=${cli} cwd=${workingDir}` +
        ` apiKey=${maskKey(rawApiKey)}${provisioned ? ' (provisioned)' : ' (reused)'}`,
    );
    return (
      `spawn_agent ok: agent=${agentId.slice(0, 8)} cli=${cli} cwd=${workingDir}` +
      ` apiKey=${provisioned ? 'provisioned' : 'reused'}`
    );
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
}
