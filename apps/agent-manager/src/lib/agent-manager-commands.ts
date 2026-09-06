// ST-5b — handle agent_manager_command SSE events.
//
// Event shape (from server, see common/types/stream-events on AWB):
//   {
//     command_id:   string,
//     instance_id:  string,            // target manager instance
//     agent_id:     string,            // server fills with the MANAGER'S identity
//                                      // (NOT the target managed agent — see below)
//     command:      'spawn_agent' | 'stop_agent' | 'restart_agent'
//                 | 'restart_all_agents'
//                 | 'set_working_dir' | 'reload_config'
//                 | 'update_plugins' | 'refresh_mcp_config'
//                 | 'update_manager' | 'restart_manager',
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
import { normalizeCredentialFields } from './credential-fields.js';
import {
  postCommandAck,
  fetchAgentRecord,
  fetchAgentCredential,
  provisionManagedAgentApiKey,
  requestManagerTriggerRepush,
  type AwbConfig,
} from './rest.js';
import type { ManagedAgentRegistry } from './managed-agents.js';
import type { ManagedAgentContextRegistry } from './managed-agent-context.js';
import type { BaseSessionManager } from './base-session-manager.js';
import type { ChatSessionManager } from './chat-session-manager.js';
import type { SubagentManager } from './subagent-manager.js';
import type { CircuitBreaker } from './circuit-breaker.js';
import type { RuntimeSupervisor } from './runtime/runtime-supervisor.js';
import {
  ensureManagedAgentDir,
  readApiKey,
  readAgentCredential,
  readManagedAgentConfig,
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
import { createRuntimeCliAdapter } from './runtime/runtime-registry.js';
import { runSelfUpdate, restartManager } from './self-update.js';
import type { CliLoginManager } from './cli-login.js';

type CommandKind =
  | 'spawn_agent'
  | 'stop_agent'
  | 'restart_agent'
  | 'restart_all_agents'
  | 'set_working_dir'
  | 'reload_config'
  | 'update_plugins'
  | 'refresh_mcp_config'
  | 'update_manager'
  | 'restart_manager'
  // ticket 6ff827cb — issued by the keep_chat_session_alive MCP tool, not an
  // admin action. args: { agent_id, room_id, minutes?, reason? }.
  | 'extend_chat_keepalive'
  | 'release_chat_keepalive'
  // ticket b2e79108 — Codex CLI device-auth 자동 로그인. args:
  // { session_id, cli }. #startCliLogin은 프로세스 spawn 확인 즉시 ack하고,
  // 실제 진행/완료는 CliLoginManager가 postCliLoginProgress로 별도 릴레이한다.
  | 'cli_login_start'
  | 'cli_login_cancel'
  // ticket 40110b64 — 호스트의 CLI 를 업그레이드한 뒤 매니저 재시작 없이 모델
  // 목록만 다시 열거한다. args 없음. 재열거 직후 즉시 하트비트 1회를 보내
  // 서버 레지스트리가 다음 정기 tick(최대 30초)을 기다리지 않게 한다.
  | 'refresh_available_models';

// Primary required field per credential provider — the one that carries the
// actual auth secret. When the server returns a credential row with this
// field empty/missing, the manager treats it as misconfigured and falls back
// to operator HOME with an explicit error log (rather than writing an empty
// `.credentials.json` / `auth.json` / `oauth_creds.json` into cli-home,
// which silently breaks CLI auth). Optional secondary fields like codex's
// `config_toml` are intentionally excluded — they're not auth-bearing.
const REQUIRED_CREDENTIAL_FIELDS: Record<string, string[]> = {
  claude_subscription: ['credentials_json'],
  claude_api_key: ['api_key'],
  claude_oauth_token: ['oauth_token'],
  deepseek_api_key: ['api_key'],
  codex_subscription: ['auth_json'],
  codex_api_key: ['api_key'],
  antigravity_subscription: ['oauth_creds_json'],
  antigravity_api_key: ['api_key'],
};

const KNOWN_COMMANDS: ReadonlySet<CommandKind> = new Set<CommandKind>([
  'spawn_agent',
  'stop_agent',
  'restart_agent',
  'restart_all_agents',
  'set_working_dir',
  'reload_config',
  'update_plugins',
  'refresh_mcp_config',
  'update_manager',
  'restart_manager',
  'extend_chat_keepalive',
  'release_chat_keepalive',
  'cli_login_start',
  'cli_login_cancel',
  'refresh_available_models',
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
  /** Persistent session managers owned by main.ts. Wired so stop_agent /
   * restart_agent can force-kill the agent's live chat / ticket CLI children
   * — without this, a credential rotation only refreshes disk artefacts and
   * the in-memory child keeps authenticating with the stale credential until
   * its idle / maxTurns timer expires (10+ minutes). Optional so the legacy
   * test harness (deps without session managers) keeps wiring up. */
  /** ticket 6ff827cb: also needs applyRoomKeepAlive for
   *  extend/release_chat_keepalive. Typed against ChatSessionManager
   *  specifically (not BaseSessionManager) because that method encapsulates
   *  the `roomId|agentId` composite session-key format — a detail this
   *  handler must not need to know. */
  chatSessionManager?: Pick<ChatSessionManager, 'stopForAgent' | 'applyRoomKeepAlive'> | null;
  ticketSessionManager?: Pick<BaseSessionManager, 'stopForAgent'> | null;
  /** SubagentManager — wired so stop_agent / restart_agent also reap the
   * agent's one-shot trigger / chat / mention subagents. These spawn detached
   * and captured their apiKey + cli-home env at spawn time, so without this a
   * credential rotation never reaches them and a zombie keeps burning turns
   * against the expired OAuth until its TTL sweep retires it. Optional so the
   * legacy test harness (deps without a subagent manager) keeps wiring up. */
  subagentManager?: Pick<SubagentManager, 'stopForAgent'> | null;
  /** Circuit-breaker — reset on restart_agent so re-pushed triggers aren't
   * blocked by stale failure counts from the previous credential. */
  circuitBreaker?: CircuitBreaker | null;
  /** Protocol runtime owner; stops Hermes process trees with the Agent. */
  runtimeSupervisor?: Pick<RuntimeSupervisor, 'stopForAgent'> | null;
  /** Optional config-reload hook; resolves with a short summary string. */
  reloadConfig?: () => Promise<string> | string;
  /** ticket b831b896: total chat / action / QA / ticket-dispatch sessions
   *  currently live, across every session manager main.ts owns. Passed
   *  through to runSelfUpdate so `update_manager` defers the restart while
   *  real work is in flight instead of SIGTERMing it moments after it
   *  starts. Optional so the legacy test harness (deps without this) keeps
   *  wiring up — runSelfUpdate treats a missing callback as "unknown,
   *  don't block". */
  countInFlightSessions?: () => number;
  /** Force-drop and re-establish the SSE connection. Called after a successful
   * `spawn_agent` so the server's cached `managedAgentIds` set (which is
   * snapshotted once per SSE connect — see events.controller.ts:236-244)
   * picks up the freshly-registered managed agent. Without this, the next
   * chat_request/agent_trigger/comment_mention for that agent is silently
   * dropped by the server fan-out filter and no subagent ever spawns.
   * Returns a Promise that resolves once the SSE stream is re-established,
   * so spawn_agent can await it before acking. */
  requestStreamReconnect?: () => Promise<void> | void;
  /** ticket b2e79108 — runs codex login --device-auth in an isolated
   *  CODEX_HOME and relays progress/completion over its own REST channel
   *  (see cli-login.ts). Optional so the legacy test harness (deps without
   *  a login manager) keeps wiring up; #startCliLogin throws a clear error
   *  if a cli_login_start arrives with none wired. */
  cliLoginManager?: Pick<CliLoginManager, 'isBusy' | 'start' | 'cancel'> | null;
  /** ticket 40110b64 — 설치된 CLI 들의 모델 목록을 다시 열거해 하트비트가 싣는
   *  캐시를 교체하고, 즉시 하트비트 1회를 보낸다. 열거·전송 모두 main.ts 가
   *  소유하므로(어댑터 레지스트리 · InstanceHeartbeat 인스턴스) 여기서는 배선된
   *  콜백만 부른다. Optional 이라 이 dep 없이 만든 레거시 테스트 하네스도 그대로
   *  동작한다 — 대신 그 경우 커맨드는 명확한 사유와 함께 error 로 ack 된다. */
  refreshAvailableModels?: (() => Promise<RefreshAvailableModelsResult>) | null;
}

/** refresh_available_models 한 번의 결과. */
export interface RefreshAvailableModelsResult {
  /** cliType → 모델 id 목록. 열거에 실패했거나 모델이 없는 CLI 는 키가 없다. */
  models: Record<string, string[]>;
  /** 즉시 하트비트 1회가 실제로 서버에 도달했는지. false 여도 커맨드는 성공이며,
   *  다음 정기 하트비트(최대 30초)가 같은 값을 다시 싣고 간다. */
  heartbeatPosted: boolean;
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
      case 'restart_all_agents':
        return this.#restartAllAgents(payload);
      case 'set_working_dir':
        return this.#setWorkingDir(payload);
      case 'reload_config':
        return this.#reloadConfig();
      case 'update_plugins':
        return this.#updatePlugins(payload);
      case 'refresh_mcp_config':
        return this.#refreshMcpConfig(payload);
      case 'update_manager':
        return this.#updateManager();
      case 'restart_manager':
        return this.#restartManager();
      case 'extend_chat_keepalive':
        return this.#applyChatKeepalive(payload, 'extend');
      case 'release_chat_keepalive':
        return this.#applyChatKeepalive(payload, 'release');
      case 'cli_login_start':
        return this.#startCliLogin(payload);
      case 'cli_login_cancel':
        return this.#cancelCliLogin(payload);
      case 'refresh_available_models':
        return this.#refreshAvailableModels();
    }
  }

  /**
   * ticket 40110b64 — 설치된 CLI 들의 모델 목록을 다시 열거해, 하트비트가 싣는
   * 캐시를 매니저 재시작 없이 교체한다. 재열거 자체는 어댑터별 try/catch 로
   * 감싼 best-effort 라, 일부 CLI 의 listModels() 가 실패해도 나머지는 갱신되고
   * 커맨드 전체는 성공으로 ack 된다 — 실패한 CLI 는 결과 맵에서 키가 빠질 뿐이다.
   *
   * 즉시 하트비트 전송이 실패한 경우도 커맨드는 성공이다(다음 정기 tick 이 같은
   * 값을 다시 싣고 간다). 다만 운영자가 "왜 아직 UI 에 안 보이지"를 묻지 않도록
   * ack detail 에 그 사실을 덧붙인다.
   */
  async #refreshAvailableModels(): Promise<string> {
    const refresh = this.#deps.refreshAvailableModels;
    if (!refresh) {
      throw new Error('refresh_available_models is not wired on this manager');
    }
    const result = await refresh();
    const entries = Object.entries(result?.models ?? {})
      .map(([cli, models]) => [cli, Array.isArray(models) ? models.length : 0] as const)
      .sort(([a], [b]) => a.localeCompare(b));
    const summary = entries.length
      ? `refreshed ${entries.length} CLI(s): ${entries.map(([cli, n]) => `${cli}=${n}`).join(', ')}`
      : 'refreshed 0 CLI(s): no installed CLI reported any model';
    return result?.heartbeatPosted
      ? summary
      : `${summary} (immediate heartbeat post failed — the next periodic heartbeat carries it)`;
  }

  /**
   * Pull the latest agent-manager source, reinstall deps, rebuild dist/,
   * then schedule a detached re-exec so the new build takes over the
   * lockfile from the dying parent. Same flow on Linux + Windows — the
   * runSelfUpdate helper handles the platform-specific bits (npm.cmd via
   * shell:true on Windows, bare npm everywhere else).
   *
   * The ack lands first (callers always ack on dispatch return); the
   * re-exec is scheduled on a ~1.5s timer inside runSelfUpdate so the
   * ack POST can complete before the parent process exits.
   *
   * Drain check (ticket b831b896, round 2): once channel/npm-reachability/
   * provenance/already-latest are all resolved and an install is
   * DEFINITELY about to happen, runSelfUpdate checks `countInFlightSessions`
   * ONCE. A non-zero count returns immediately with `deferred:true` instead
   * of blocking — UpdateChecker's periodic tick retries automatically until
   * SELF_UPDATE_DRAIN_MAX_WAIT_MS elapses. This method (and therefore the
   * SSE ack) always returns quickly, regardless of drain outcome — round 1
   * blocked in-call for up to the drain cap, which held the module-level
   * in-flight mutex that long (silently no-op'ing a concurrent operator
   * `restart_manager`) and routinely made the ack arrive after the server's
   * command-ledger TTL (`RECORD_TTL_MS`, also 10 minutes), getting rejected
   * even though the update itself went on to succeed.
   *
   * Concurrency: runSelfUpdate enforces a module-level in-flight mutex
   * shared with the SIGUSR1 handler, held only for the duration of one
   * quick check (never across the drain wait — see above). A second
   * update_manager dispatched while one is still running short-circuits to
   * {changed:false, summary:'self-update already in flight'}; we throw on
   * that so the REST ack carries 'error' rather than silently no-op'ing —
   * operators see the contention on the admin UI. `deferred:true` is
   * deliberately NOT thrown as an error — the update is pending, not
   * refused or failed.
   */
  async #updateManager(): Promise<string> {
    // ticket 9408b308: 이 명령을 낼 수 있는 주체가 곧 정책 D 가 말하는 승인
    // 주체(workspace admin)다 — 새 권한 축을 만들지 않고 이 명령 자체를 승인으로
    // 기록한다. `scheduled` 호스트에서 이 설치가 지금 끝나지 못하더라도 다음 창의
    // tick 이 같은 버전을 다시 묻지 않고 이어서 개시한다.
    const result = await runSelfUpdate({
      log,
      countInFlightSessions: this.#deps.countInFlightSessions,
      approvalSource: 'update_manager',
    });
    if (!result.changed && !result.deferred) {
      throw new Error(`update_manager: ${result.summary}`);
    }
    return `update_manager ok: ${result.summary}`;
  }

  /**
   * Re-exec the manager in place — no git pull, no install, no build. The
   * old process schedules a detached child on a 1.5s timer (so this method
   * can return + the REST ack POST can land first), then SIGTERMs itself
   * so the platform's shutdown handler tears down chat / ticket sessions
   * cleanly before exit.
   *
   * Shares restartManager's mutex with runSelfUpdate so a restart racing an
   * update doesn't double-schedule the re-exec; the loser gets a
   * `{changed:false}` and we throw so the REST ack carries 'error'.
   */
  async #restartManager(): Promise<string> {
    const result = await restartManager({ log });
    if (!result.changed) {
      throw new Error(`restart_manager: ${result.summary}`);
    }
    return `restart_manager ok: ${result.summary}`;
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
    // Per-agent default model. Prefer the canonical AWB record (remote.model);
    // fall back to the spawn payload's args.model. Empty string = unset → the
    // CLI's own default (no --model flag), preserving prior behaviour.
    const model =
      (typeof (remote as any)?.model === 'string' && (remote as any).model.trim()) ||
      (typeof payload.args?.model === 'string' && payload.args.model.trim()) ||
      '';
    const runtimeConfig = remote?.runtime_config ?? payload.args?.runtime_config ?? null;
    const workspaceId = String(payload.args?.workspace_id || (remote as any)?.workspace_id || this.#config.workspace_id || '').trim();

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
      workspace_id: workspaceId,
      model: model || null,
      runtime_config: runtimeConfig,
      last_spawn_at: new Date().toISOString(),
    });

    // 4. apiKey: reuse on-disk if present (faster + avoids unnecessary
    // rotation); else provision a fresh one. The server's provision
    // endpoint is idempotent in the "rotate any prior provisioned" sense,
    // so a fresh provision here is also safe — we just don't gratuitously
    // rotate every spawn_agent (e.g. on a manager restart).
    let rawApiKey = await readApiKey(agentId, workspaceId);
    let provisioned = false;
    if (!rawApiKey) {
      const issued = await provisionManagedAgentApiKey(this.#config, agentId, workspaceId);
      if (!issued?.raw_key) {
        throw new Error('spawn_agent: apiKey provisioning failed (server returned no key)');
      }
      rawApiKey = issued.raw_key;
      await writeApiKey(agentId, rawApiKey, workspaceId);
      provisioned = true;
    }
    // Ticket ee26302d: same gap as #refreshMcpConfig below — no resolved
    // profile at spawn_agent time, so this static file always starts
    // 'full'; a subsequent ticket/chat spawn corrects it if needed.
    const mcpConfigPath = await writeMcpConfig(agentId, this.#config.url, rawApiKey, workspaceId);

    // ST-7 follow-up: per-agent CLI home dir. Created lazily here so the
    // CLI (claude/codex/antigravity) writes its sessions / plugins / settings
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
    const credential = await this.#resolveAgentCredential(agentId, cli, credentialIdHint, workspaceId);
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
    if (cli !== 'hermes') {
    try {
      // Pass AWB URL + per-agent apiKey so adapters that consume MCP
      // servers via a static config file (antigravity → mcp_config.json) can
      // persist the `awb` server into cli-home at spawn_agent time.
      // Codex treats the generated native config as required; the catch
      // branch below aborts registration if materialization fails.
      const prep = await createRuntimeCliAdapter(cli).prepareCliHome(
        cliHomeDir,
        credential,
        { url: this.#config.url, apiKey: rawApiKey },
        // Per-agent model — deepseek folds this into ANTHROPIC_MODEL so its env
        // and the inherited `--model` flag agree; other adapters ignore it.
        model || null,
      );
      extraEnv = prep?.extraEnv ?? {};
    } catch (err: any) {
      const detail = `spawn_agent: cli-home prep failed for agent=${agentId.slice(0, 8)} cli=${cli}: ${err?.message ?? err}`;
      log(detail);
      if (cli === 'codex') {
        this.#deps.registry.markStopped(agentId, detail);
        throw new Error(detail);
      }
    }
    }

    // 5. context registry — EventDispatcher reads this on every event
    if (this.#deps.contextRegistry) {
      this.#deps.contextRegistry.upsert({
        agent_id: agentId,
        workspace_id: workspaceId,
        name,
        cli,
        working_dir: workingDir,
        mcp_config_path: mcpConfigPath,
        api_key: rawApiKey,
        subagent_log_path: subagentLogPathFor(agentId),
        cli_home_dir: cliHomeDir,
        model: model || null,
        runtime_config: runtimeConfig,
        extra_env: extraEnv,
        // Threaded through so spawn sites can strip operator-inherited auth
        // env vars (ANTHROPIC_API_KEY / OPENAI_API_KEY / …) when an agent
        // has its own credential — without this, the operator's shell env
        // silently overrides the per-agent .credentials.json/auth.json.
        credential_provider: credential?.provider ?? null,
        credential_id: credential?.credential_id ?? null,
        // Credential expiry monitoring needs to know the auth mode without
        // re-running the resolver each heartbeat. Stamp it here from the
        // resolved credential's provider suffix (after the cli prefix).
        credential_kind: credentialKind(credential),
        registered_at: new Date().toISOString(),
      });
    }

    // 6. mark running. pid=process.pid means "managed by THIS manager";
    // there's no per-agent permanent process to track, but the heartbeat
    // surface still wants a live pid for the dashboard.
    this.#deps.registry.markRunning(agentId, process.pid);

    // 7. force a fresh SSE connect so the server's cached managedAgentIds
    // set picks up this agent. Without this, the next chat_request /
    // agent_trigger / comment_mention targeted at <agentId> is silently
    // filtered out by the server's per-event fan-out and the user reports
    // a brand-new managed agent that "doesn't respond to anything".
    // Awaited so the ack POST only fires after the SSE stream is live with
    // the new agent in its managedAgentIds set — closing the race window
    // where a user sending a chat message between ack and reconnect would
    // have it silently dropped. The reconnect() Promise has a built-in
    // 10s safety timeout so the ack is never blocked indefinitely.
    await this.#deps.requestStreamReconnect?.();

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
    workspaceId?: string,
  ): Promise<ManagedAgentCredential | null> {
    const fetched = await fetchAgentCredential(this.#config, agentId, workspaceId);
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
    // Server returned a credential row, but the required field for this
    // provider is empty. Two real-world causes seen so far:
    //   1. Operator created the credential row in AWB UI without pasting the
    //      `.credentials.json` / `auth.json` / `oauth_creds.json` content.
    //   2. Server-side decrypt failed silently (pre-fix the controller would
    //      catch JSON.parse on '' and return 200 OK with fields={}). New
    //      controller now returns 503 in that case, but stale servers still
    //      observe this codepath.
    // Either way: writing an empty credential file silently breaks auth in a
    // way that's hard to diagnose from the CLI's own error. Log loud + return
    // null so caller falls back to operator HOME (legacy).
    // Strip whitespace the operator's paste smuggled into the secret before
    // anything consumes it. An interior newline in an OAuth token is not a
    // soft problem: the CLI puts it in an Authorization header and every
    // request fails, for every agent sharing the credential.
    const { fields, repaired } = normalizeCredentialFields(fetched.fields);
    if (repaired.length > 0) {
      log(
        `spawn_agent: agent=${agentId.slice(0, 8)} credential=${fetched.provider} ` +
          `(id=${fetched.credential_id.slice(0, 8)}) carried whitespace inside field(s) ` +
          `${repaired.join(',')} — stripped. Re-save the credential in AWB Settings → Credentials.`,
      );
    }

    const required = REQUIRED_CREDENTIAL_FIELDS[fetched.provider];
    if (required) {
      const present = required.filter((k) => {
        const v = fields[k];
        return typeof v === 'string' && v.length > 0;
      });
      if (present.length === 0) {
        log(
          `spawn_agent: agent=${agentId.slice(0, 8)} credential=${fetched.provider} ` +
            `(id=${fetched.credential_id.slice(0, 8)}) has empty required field(s) ${required.join(',')} — ` +
            `re-edit the credential in AWB Settings → Credentials. Falling back to operator HOME.`,
        );
        return null;
      }
    }
    return {
      credential_id: fetched.credential_id,
      provider: fetched.provider,
      fields,
    };
  }

  async #stopAgent(payload: AgentManagerCommandPayload): Promise<string> {
    const agentId = this.#targetAgentId(payload, 'stop_agent');
    const { summary } = await this.#reapAgent(agentId, 'stop_agent command');
    return summary;
  }

  /**
   * Tear down everything this manager holds for `agentId`: drop the runtime
   * context, mark the registry stopped, force-kill the agent's live persistent
   * chat/ticket children AND its detached one-shot subagents, then erase its
   * on-disk secrets so the next spawn re-provisions. Shared by stop_agent and
   * restart_agent. Returns a human-readable ack summary plus the de-duplicated
   * in-flight (ticket, role) set the killed children/subagents were holding —
   * restart_agent re-pushes those for immediate resume on the new credential.
   */
  async #reapAgent(
    agentId: string,
    reason: string,
  ): Promise<{ summary: string; inflight: Array<{ ticket_id: string; role: string }> }> {
    const hadContext = this.#deps.contextRegistry?.delete(agentId) ?? false;
    const rec = this.#deps.registry.markStopped(agentId, reason);
    // De-dup in-flight (ticket, role) work across all three managers so a
    // single ticket worked by both a persistent session and a one-shot
    // subagent (or duplicated across them) is only re-pushed once.
    const inflightByKey = new Map<string, { ticket_id: string; role: string }>();
    const captureInflight = (ticketId: string | null | undefined, role: string | null | undefined): void => {
      if (!ticketId) return;
      const r = role || '';
      inflightByKey.set(`${ticketId}:${r}`, { ticket_id: ticketId, role: r });
    };
    // Force-kill the agent's live chat/ticket CLI children FIRST. Each child
    // captured its env (.credentials.json, ANTHROPIC_AUTH_TOKEN, …) at spawn
    // time; without this signal pass, restart_agent + a freshly pasted
    // credential only refresh disk artefacts and the running child keeps
    // dispatching turns against the expired OAuth until its idle timer
    // (default 10min) or maxTurns kicks it out. Failures are non-fatal —
    // we still want to drop the context + secrets even if a manager has
    // somehow constructed the handler without session managers.
    let chatKilled = 0;
    let ticketKilled = 0;
    let subagentKilled = 0;
    let runtimeKilled = 0;
    try {
      const r = await this.#deps.chatSessionManager?.stopForAgent(agentId);
      chatKilled = r?.count ?? 0;
      for (const w of r?.inflight ?? []) captureInflight(w.ticketId, w.role);
    } catch (err: any) {
      log(`${reason}: chatSessionManager.stopForAgent failed: ${err?.message ?? err}`);
    }
    try {
      const r = await this.#deps.ticketSessionManager?.stopForAgent(agentId);
      ticketKilled = r?.count ?? 0;
      for (const w of r?.inflight ?? []) captureInflight(w.ticketId, w.role);
    } catch (err: any) {
      log(`${reason}: ticketSessionManager.stopForAgent failed: ${err?.message ?? err}`);
    }
    // Reap the detached one-shot subagents (trigger / chat / mention). This is
    // the direct fix for "기존에 떠있던 subagent 는 계속 안돼" — they were never
    // wired into stop_agent before, so a restart left them running on the dead
    // credential.
    try {
      const r = await this.#deps.subagentManager?.stopForAgent(agentId);
      subagentKilled = r?.count ?? 0;
      for (const w of r?.inflight ?? []) captureInflight(w.ticket_id, w.role);
    } catch (err: any) {
      log(`${reason}: subagentManager.stopForAgent failed: ${err?.message ?? err}`);
    }
    try {
      const r = await this.#deps.runtimeSupervisor?.stopForAgent(agentId);
      runtimeKilled = r?.count ?? 0;
    } catch (err: any) {
      log(`${reason}: runtimeSupervisor.stopForAgent failed: ${err?.message ?? err}`);
    }
    // Erase on-disk secrets so the next spawn_agent re-provisions a fresh
    // key. This is the expected security posture: an admin stopping an
    // agent invalidates its credentials on the next start.
    await eraseSecrets(agentId).catch(() => undefined);
    const inflight = Array.from(inflightByKey.values());
    if (
      !rec
      && !hadContext
      && chatKilled === 0
      && ticketKilled === 0
      && subagentKilled === 0
      && runtimeKilled === 0
    ) {
      // Unknown to this manager — likely never spawned here. Treat as a
      // no-op success so the operator's ack reflects "nothing to do".
      return {
        summary: `stop_agent: agent=${agentId.slice(0, 8)} not running on this manager`,
        inflight,
      };
    }
    return {
      summary:
        `stop_agent ok: agent=${agentId.slice(0, 8)} ` +
        `(context dropped, secrets erased, chat_sessions=${chatKilled} ` +
        `ticket_sessions=${ticketKilled} subagents=${subagentKilled} runtimes=${runtimeKilled})`,
      inflight,
    };
  }

  async #restartAgent(payload: AgentManagerCommandPayload): Promise<string> {
    // Asserts args.agent_id once up front — both inner calls reuse it via payload.
    const agentId = this.#targetAgentId(payload, 'restart_agent');
    // Reset circuit-breaker for this agent — the operator presumably fixed
    // the config/credential issue that triggered the breaker, so the
    // re-pushed triggers should be allowed through immediately.
    this.#deps.circuitBreaker?.resetAgent(agentId);
    // Capture the in-flight (ticket, role) work BEFORE the teardown so we can
    // re-push it on the fresh credential. A reap failure must not block the
    // respawn — fall back to an empty set (the server supervisor still
    // re-pushes stale work, just on its slower ~30-min cadence).
    let inflight: Array<{ ticket_id: string; role: string }> = [];
    try {
      const reaped = await this.#reapAgent(agentId, 'restart_agent command');
      inflight = reaped.inflight;
    } catch (err: any) {
      log(`restart_agent: reap failed (continuing with respawn): ${err?.message ?? err}`);
    }
    const detail = await this.#spawnAgent(payload);
    // Re-push interrupted work AFTER the fresh spawn — #spawnAgent awaits the
    // SSE reconnect, so by here the server's managedAgentIds snapshot already
    // includes this agent and the emitted trigger will route to the new child.
    let resumeNote = '';
    if (inflight.length > 0) {
      const res = await requestManagerTriggerRepush(this.#config, agentId, inflight);
      if (res) {
        resumeNote = ` · resumed ${res.emitted}/${inflight.length} in-flight ticket(s)`;
      } else {
        resumeNote = ` · resume re-push failed for ${inflight.length} ticket(s) (supervisor will retry)`;
      }
      log(
        `restart_agent: agent=${agentId.slice(0, 8)} re-pushed ${inflight.length} in-flight (ticket,role) — ` +
          (res ? `emitted=${res.emitted} skipped=${res.skipped}` : 'transport failed'),
      );
    }
    return `restart_agent → ${detail}${resumeNote}`;
  }

  /**
   * Reap + respawn EVERY agent this manager currently supervises — the
   * instance-wide counterpart to restart_agent. The manager process itself
   * stays up (no re-exec): heartbeat + lockfile are untouched, so this is a
   * zero-downtime, lightweight way to apply rotated credentials / models /
   * working-dirs to all agents at once.
   *
   * Why this is NOT restart_manager: re-exec'ing the process rehydrates each
   * agent from the on-disk credential snapshot (no AWB re-fetch) and only
   * resumes in-flight work on the server supervisor's slow ~30-min cadence.
   * Fanning out per-agent #restartAgent instead preserves the three things
   * that matter: (1) fresh credential fetch from AWB (#spawnAgent →
   * #resolveAgentCredential after #reapAgent's eraseSecrets), (2) immediate
   * per-agent in-flight (ticket,role) re-push, (3) no process downtime.
   *
   * Targets are the *live* agents (running | spawning) — operator-stopped
   * agents stay stopped (we don't resurrect what an admin deliberately
   * stopped). Iteration is SEQUENTIAL: concurrent restarts would race on the
   * shared ~/.claude/.credentials.json the CLI rewrites on credential refresh.
   * One agent's failure is isolated via per-agent try/catch and does not block
   * the rest. Zero managed agents → clean no-op ack.
   */
  async #restartAllAgents(payload: AgentManagerCommandPayload): Promise<string> {
    const agentIds = this.#deps.registry.liveAgentIds();
    if (agentIds.length === 0) {
      return 'restart_all_agents → no managed agents (no-op)';
    }
    let restarted = 0;
    const failed: string[] = [];
    for (const agentId of agentIds) {
      // Synthesize a per-agent payload so #restartAgent's args.agent_id
      // extractor (#targetAgentId) targets each agent in turn — the inbound
      // restart_all_agents payload carries no agent_id of its own.
      const perAgent: AgentManagerCommandPayload = {
        ...payload,
        args: { ...(payload.args || {}), agent_id: agentId },
      };
      try {
        const detail = await this.#restartAgent(perAgent);
        restarted++;
        log(`restart_all_agents: agent=${agentId.slice(0, 8)} ok — ${detail}`);
      } catch (err: any) {
        failed.push(agentId.slice(0, 8));
        log(`restart_all_agents: agent=${agentId.slice(0, 8)} FAILED: ${err?.message ?? err}`);
      }
    }
    const failNote = failed.length > 0 ? ` (failed: ${failed.join(', ')})` : '';
    return `restart_all_agents → ${restarted} restarted, ${failed.length} failed${failNote}`;
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
    // Heal the hot-path context registry too. The heartbeat registry above is the
    // status source of truth, but EventDispatcher roots subagent cwd + 규약 ②/③
    // worktree/run folders off the CONTEXT registry — leaving it stale means every
    // dispatch until the next spawn_agent still uses the OLD working_dir (the exact
    // drift that placed GameClient QA runs at the wrong base). No-op when the agent
    // has no live context yet (never spawned since this manager booted).
    const healed = this.#deps.contextRegistry?.setWorkingDir(agentId, workingDir) ?? false;
    return `set_working_dir: agent=${agentId.slice(0, 8)} cwd=${workingDir}${healed ? ' (context cache healed)' : ''}`;
  }

  /**
   * ticket 6ff827cb requirement 3 — apply an extend/release keep-alive grant
   * to the calling agent's own live chat session. Unlike every other command
   * here, this one is issued by the keep_chat_session_alive MCP tool (not an
   * admin action) from WITHIN a live session's own turn — args.agent_id is
   * that session's own agent, not an arbitrary target. The server already
   * checked the caller is an active ChatRoomParticipant of args.room_id
   * before issuing this; #applyChatKeepalive just routes it to the matching
   * (roomId, agentId) session via ChatSessionManager#applyRoomKeepAlive,
   * which encapsulates the `roomId|agentId` composite session-key format.
   */
  #applyChatKeepalive(payload: AgentManagerCommandPayload, action: 'extend' | 'release'): string {
    const agentId = this.#targetAgentId(payload, `${action}_chat_keepalive`);
    const roomId = typeof payload.args?.room_id === 'string' ? payload.args.room_id.trim() : '';
    if (!roomId) throw new Error(`${action}_chat_keepalive: args.room_id is required`);
    if (!this.#deps.chatSessionManager) {
      throw new Error(`${action}_chat_keepalive: no chat session manager wired on this deployment`);
    }
    const minutes = typeof payload.args?.minutes === 'number' ? payload.args.minutes : undefined;
    const reason = typeof payload.args?.reason === 'string' ? payload.args.reason : undefined;
    const result = this.#deps.chatSessionManager.applyRoomKeepAlive(roomId, agentId, { action, minutes, reason });
    if (!result.ok) {
      throw new Error(`${action}_chat_keepalive: ${result.error ?? 'failed (no live session for this room/agent?)'}`);
    }
    return action === 'release'
      ? `release_chat_keepalive ok: agent=${agentId.slice(0, 8)} room=${roomId.slice(0, 8)}`
      : `extend_chat_keepalive ok: agent=${agentId.slice(0, 8)} room=${roomId.slice(0, 8)} ` +
          `until=${result.until ? new Date(result.until).toISOString() : '-'}`;
  }

  /**
   * ticket b2e79108 — kick off `codex login --device-auth` in an isolated
   * CODEX_HOME. Only confirms the process spawned (CliLoginManager.start
   * resolves as soon as it sees the child's 'spawn' event, not on
   * completion) — command/ack's ledger 410s anything past 10 minutes and a
   * human completing the browser approval can easily take longer than that.
   * All subsequent state (awaiting_user url/code, succeeded/failed/
   * timed_out/cancelled) is relayed by CliLoginManager itself via
   * postCliLoginProgress, a separate REST channel with no ack-TTL tied to
   * this dispatch.
   */
  async #startCliLogin(payload: AgentManagerCommandPayload): Promise<string> {
    const sessionId = String(payload.args?.session_id || '').trim();
    if (!sessionId) throw new Error('cli_login_start: args.session_id is required');
    const cli = String(payload.args?.cli || '').trim().toLowerCase();
    if (!cli) throw new Error('cli_login_start: args.cli is required');
    if (!this.#deps.cliLoginManager) {
      throw new Error('cli_login_start: no cli-login manager wired on this deployment');
    }
    await this.#deps.cliLoginManager.start({ sessionId, commandId: payload.command_id, cli });
    return `cli_login_start ok: session=${sessionId.slice(0, 8)} cli=${cli} process spawned, awaiting user`;
  }

  /**
   * Best-effort — server dispatches this when a user cancels from the UI.
   * If the manager has no memory of the session (already finished, or a
   * stray dispatch for a session another manager instance owns), this is a
   * harmless no-op rather than an error: the server already marks the
   * session cancelled regardless of whether this reaches the right process.
   */
  async #cancelCliLogin(payload: AgentManagerCommandPayload): Promise<string> {
    const sessionId = String(payload.args?.session_id || '').trim();
    if (!sessionId) throw new Error('cli_login_cancel: args.session_id is required');
    const cancelled = (await this.#deps.cliLoginManager?.cancel(sessionId)) ?? false;
    return cancelled
      ? `cli_login_cancel ok: session=${sessionId.slice(0, 8)} cancelled`
      : `cli_login_cancel: session=${sessionId.slice(0, 8)} not active on this manager (already finished?)`;
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
    const ctx = this.#deps.contextRegistry?.get(agentId);
    const diskConfig = ctx ? null : await readManagedAgentConfig(agentId);
    const workspaceId = String(payload.args?.workspace_id || ctx?.workspace_id || diskConfig?.workspace_id || '').trim();
    const rawApiKey = await readApiKey(agentId, workspaceId || undefined);
    if (!rawApiKey) {
      throw new Error(
        `refresh_mcp_config: no apiKey on disk for agent=${agentId.slice(0, 8)} ` +
          `(spawn_agent first to provision)`,
      );
    }
    // Ticket ee26302d: no resolved Claude backend profile (context_window)
    // is available at this admin-triggered refresh — always writes 'full'.
    // The next actual ticket/chat spawn through base-session-manager.ts /
    // subagent-manager.ts rewrites this same file with the compact header
    // if that session's resolved profile calls for it (see those files'
    // "reuse-if-exists fast path" branches), so this is a transient gap,
    // not a permanent one.
    const path = await writeMcpConfig(agentId, this.#config.url, rawApiKey, workspaceId || undefined);
    const cli = ctx?.cli ?? diskConfig?.cli;
    if (cli) {
      await ensureCliHomeDir(agentId);
      await createRuntimeCliAdapter(cli).prepareCliHome(
        ctx?.cli_home_dir ?? cliHomeDirFor(agentId),
        await readAgentCredential(agentId),
        { url: this.#config.url, apiKey: rawApiKey },
        ctx?.model ?? diskConfig?.model ?? null,
      );
    }
    return `refresh_mcp_config ok: agent=${agentId.slice(0, 8)} path=${path}`;
  }

  /**
   * Update plugin marketplace checkouts in the managed agent's cli-home. Each
   * marketplace under `<cli-home>/plugins/marketplaces/<id>/` is a git
   * checkout of the marketplace repo, so a `git pull --ff-only` in that dir
   * is the cheapest way to refresh the plugin source without restarting the
   * agent. Implementation:
   *   - List `<cli-home>/plugins/marketplaces/` (silently skip if missing).
   *   - For each entry that is a git repo, run `git pull --ff-only`. Failures
   *     are collected per-entry and reported back; a single failed
   *     marketplace doesn't block the others.
   *   - For non-claude managed agents (codex/antigravity), the dir layout doesn't
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

}

// ─── helpers (kept module-scoped to avoid bloating the class API) ───────

/**
 * Map a resolved AdapterCredential (or its absence) to the auth mode the
 * heartbeat surfaces in `agent_credentials`. Only the suffix after the
 * cli prefix is consulted (`<cli>_subscription` / `<cli>_api_key`); the
 * cli prefix itself was already validated by `#resolveAgentCredential`.
 *
 * `null` credential → 'operator_home' (legacy fallback symlinks the
 * operator's HOME credential into cli-home, which still has a usable
 * expiry the heartbeat will report).
 */
function credentialKind(
  credential: ManagedAgentCredential | null,
): 'subscription' | 'api_key' | 'operator_home' {
  if (!credential) return 'operator_home';
  if (credential.provider.endsWith('_subscription')) return 'subscription';
  if (credential.provider.endsWith('_api_key')) return 'api_key';
  // claude_oauth_token is env-only (CLAUDE_CODE_OAUTH_TOKEN), writes no
  // .credentials.json, and the long-lived setup-token has no per-spawn expiry
  // file to monitor — so it's the same 'api_key' heartbeat kind (no rotation
  // tracking) rather than the 'subscription' default below, which would chase
  // a .credentials.json that never exists.
  if (credential.provider.endsWith('_oauth_token')) return 'api_key';
  // Unknown shape — assume subscription so the heartbeat still tries to
  // read .credentials.json. Worse case the adapter returns null and the
  // UI shows "no credential metadata" rather than mis-labeling api_key.
  return 'subscription';
}


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
