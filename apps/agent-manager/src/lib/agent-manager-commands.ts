// ST-5b — handle agent_manager_command SSE events.
//
// Event shape (from server, see common/types/stream-events on AWB):
//   {
//     command_id:   string,
//     instance_id:  string,            // target manager instance
//     agent_id:     string,            // target managed agent (empty for reload_config)
//     command:      'spawn_agent' | 'stop_agent' | 'restart_agent'
//                 | 'set_working_dir' | 'reload_config',
//     args:         Record<string, any>,   // command-specific (e.g. { working_dir })
//     issued_by:    string,            // user id of the admin
//     issued_at:    string,
//     timestamp:    string,
//   }
//
// Filtering: every manager subscribed to the SSE stream sees every command
// payload (the server fans out per-agent). We drop events whose
// `instance_id` doesn't match this process — that's how multiple manager
// instances sharing one Agent identity stay segregated.
//
// Acks: every command (success or stub) hits POST /api/agent-manager/command/ack
// so the server log surfaces the outcome to the operator.

import { log } from './logging.js';
import { postCommandAck, fetchAgentRecord, type AwbConfig } from './rest.js';
import type { ManagedAgentRegistry } from './managed-agents.js';

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

  async #spawnAgent(payload: AgentManagerCommandPayload): Promise<string> {
    const agentId = payload.args?.agent_id ?? payload.agent_id;
    if (!agentId) throw new Error('spawn_agent: agent_id missing');

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

    // ─── CLI lifecycle stub ───────────────────────────────────────────
    // Real implementation: launch `claude/codex/gemini` as a child process
    // chrooted at workingDir, wire stdio to a per-agent log file, and only
    // markRunning when the cli reports ready. Tracked as ST-6 follow-up.
    this.#deps.registry.markRunning(agentId, /* fake pid */ -1);
    return `spawn_agent stub: agent=${agentId.slice(0, 8)} cli=${cli} cwd=${workingDir} (lifecycle stubbed)`;
  }

  async #stopAgent(payload: AgentManagerCommandPayload): Promise<string> {
    const agentId = payload.args?.agent_id ?? payload.agent_id;
    if (!agentId) throw new Error('stop_agent: agent_id missing');
    const rec = this.#deps.registry.markStopped(agentId, 'stop_agent command');
    if (!rec) {
      // Unknown to this manager — likely never spawned here. Treat as a
      // no-op success so the operator's ack reflects "nothing to do".
      return `stop_agent: agent=${agentId.slice(0, 8)} not running on this manager`;
    }
    return `stop_agent stub: agent=${agentId.slice(0, 8)} marked stopped (lifecycle stubbed)`;
  }

  async #restartAgent(payload: AgentManagerCommandPayload): Promise<string> {
    const agentId = payload.args?.agent_id ?? payload.agent_id;
    if (!agentId) throw new Error('restart_agent: agent_id missing');
    await this.#stopAgent(payload).catch(() => undefined);
    const detail = await this.#spawnAgent(payload);
    return `restart_agent → ${detail}`;
  }

  async #setWorkingDir(payload: AgentManagerCommandPayload): Promise<string> {
    const agentId = payload.args?.agent_id ?? payload.agent_id;
    const workingDir = String(payload.args?.working_dir ?? '').trim();
    if (!agentId) throw new Error('set_working_dir: agent_id missing');
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
