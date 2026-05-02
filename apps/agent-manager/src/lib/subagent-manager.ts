// Owns the lifecycle of CLI subagent child processes (one-shot trigger / chat).
//
// Parameterized by a CliAdapter — the adapter contributes argv shape,
// mcp-config requirement, stream parsing, and one-shot result aggregation.
// For non-MCP adapters (gemini, …) the manager:
//   - Skips the per-spawn mcp-config tempfile (adapter.needsMcpConfig=false)
//   - Captures stdout lines into the record so collectOneshotResult() can
//     produce a final answer at exit time
//   - Posts that answer back to AWB via the MCP `add_comment` tool when the
//     spawn carried a ticketId

import { promises as fsp } from 'node:fs';
import { join, dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  SUBAGENTS_BASE_DIR,
  SUBAGENTS_PERSIST_PATH,
  TTL_SWEEP_INTERVAL_MS,
  SIGTERM_GRACE_MS,
  STOP_GRACE_MS,
} from './constants.js';
import { log } from './logging.js';
import { ClaudeCliAdapter } from './cli-adapters/claude.js';
import { ADAPTER_CAPABILITIES, type CliAdapter } from './cli-adapters/base.js';
import { fireAndForgetTool } from './mcp-client.js';
import type { AwbConfig } from './rest.js';
import type {
  SubagentManager as SubagentManagerContract,
  SubagentSpawnArgs,
  SubagentSpawnResult,
} from './event-dispatcher.js';
import type { SubagentMonitor, SubagentTapHandle } from './subagent-monitor.js';

const { NATIVE_MCP } = ADAPTER_CAPABILITIES;

export interface SubagentDelegationConfig {
  enabled?: boolean;
  maxConcurrent?: number;
  ttlMinutes?: number;
  claudeBin?: string;
}

export interface SubagentAwareConfig extends AwbConfig {
  delegation: SubagentDelegationConfig;
}

interface ReservationRecord {
  kind: 'reservation';
  started_at: number;
}

interface SubagentRecord {
  kind: 'trigger' | 'chat';
  pid: number;
  cli_type: string;
  trigger_id: string | null;
  chat_request_id: string | null;
  ticket_id: string | null;
  agent_id: string | null;
  started_at: number;
  expected_completion_at: number;
  config_path: string | null;
  /** ST-6: false when config_path is a managed-agent's persistent
   *  mcp-config.json file we must NOT unlink on subagent exit / cleanup. */
  config_path_is_temp: boolean;
  process_handle: ChildProcess | null;
  captureOutput: boolean;
  outLines: string[];
  tap: SubagentTapHandle | null;
}

type AnyRecord = SubagentRecord | ReservationRecord;

export interface SubagentExitInfo {
  pid: number;
  record: SubagentRecord;
  code: number | null;
  signal: NodeJS.Signals | null;
  durationSec: number;
}

export class SubagentManager implements SubagentManagerContract {
  #map = new Map<number, AnyRecord>();
  #config: SubagentAwareConfig;
  #adapter: CliAdapter;
  #sweepTimer: NodeJS.Timeout | null = null;
  #reservationCounter = 0;
  #persistPath: string;
  #pidDir: string;
  #initialized = false;
  #monitor: SubagentMonitor | null = null;

  onExit?: (info: SubagentExitInfo) => void;

  constructor(config: SubagentAwareConfig, adapter?: CliAdapter) {
    this.#config = config;
    this.#adapter = adapter || new ClaudeCliAdapter();
    this.#persistPath = SUBAGENTS_PERSIST_PATH;
    this.#pidDir = SUBAGENTS_BASE_DIR;
  }

  setMonitor(monitor: SubagentMonitor | null): void {
    this.#monitor = monitor;
  }

  async init(): Promise<void> {
    if (this.#initialized) return;
    this.#initialized = true;
    try {
      await fsp.mkdir(this.#pidDir, { recursive: true, mode: 0o700 });
    } catch (err: any) {
      log(`SubagentManager: mkdir failed: ${err?.message ?? err}`);
    }
    await this.#reconcileOnStart();
    await this.#sweepOrphanCfgs();
    this.#sweepTimer = setInterval(() => this.#sweep(), TTL_SWEEP_INTERVAL_MS);
    this.#sweepTimer.unref?.();
    log(
      `SubagentManager initialized (cli=${this.#adapter.cliType}, pidDir=${this.#pidDir}, cap=${this.#config.delegation.maxConcurrent}, ttl=${this.#config.delegation.ttlMinutes}min)`,
    );
  }

  get adapter(): CliAdapter {
    return this.#adapter;
  }

  async #sweepOrphanCfgs(): Promise<void> {
    let files: string[];
    try {
      files = await fsp.readdir(this.#pidDir);
    } catch (err: any) {
      log(`Orphan cfg sweep: readdir failed: ${err?.message ?? err}`);
      return;
    }

    const liveCfgs = new Set<string>();
    for (const rec of this.#map.values()) {
      if (rec.kind !== 'reservation' && rec.config_path) liveCfgs.add(rec.config_path);
    }
    try {
      const procEntries = await fsp.readdir('/proc');
      for (const entry of procEntries) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          const cmdline = await fsp.readFile(`/proc/${entry}/cmdline`, 'utf8');
          const parts = cmdline.split('\0');
          const idx = parts.indexOf('--mcp-config');
          if (idx >= 0 && parts[idx + 1]) liveCfgs.add(parts[idx + 1]);
        } catch {
          /* process vanished mid-scan; ignore */
        }
      }
    } catch {
      /* /proc missing (non-Linux) — rely on persist-reconciliation only */
    }

    let purged = 0;
    for (const f of files) {
      if (!f.startsWith('cfg-') || !f.endsWith('.json')) continue;
      const path = join(this.#pidDir, f);
      if (liveCfgs.has(path)) continue;
      try {
        await fsp.unlink(path);
        purged++;
      } catch {
        /* vanished; ignore */
      }
    }
    if (purged > 0) log(`Orphan cfg sweep: purged ${purged} stale config file(s)`);
  }

  canSpawn(): boolean {
    const active = this.#activeCount();
    return active < (this.#config.delegation.maxConcurrent ?? 5);
  }

  #activeCount(): number {
    let n = 0;
    for (const _ of this.#map.values()) n++;
    return n;
  }

  async spawn(spec: SubagentSpawnArgs): Promise<SubagentSpawnResult> {
    if (spec.triggerId) {
      for (const rec of this.#map.values()) {
        if (rec.kind !== 'reservation' && rec.trigger_id === spec.triggerId) {
          return { spawned: false, reason: 'duplicate_trigger' };
        }
      }
    }

    if (spec.chatRequestId) {
      for (const rec of this.#map.values()) {
        if (rec.kind !== 'reservation' && rec.chat_request_id === spec.chatRequestId) {
          return { spawned: false, reason: 'duplicate_chat' };
        }
      }
    }

    if (!this.canSpawn()) {
      return { spawned: false, reason: 'cap_reached' };
    }
    const reservationId = -(++this.#reservationCounter);
    this.#map.set(reservationId, { kind: 'reservation', started_at: Date.now() });

    // ST-6: per-call managed-agent context. When provided we (a) reuse the
    // pre-written mcp-config.json instead of a temp one, (b) authenticate as
    // the managed agent (apiKey override), and (c) cd into the managed
    // agent's working_dir so the CLI sees the right project root.
    const ctx = spec.agentContext;
    const effectiveApiKey = ctx?.api_key || this.#config.apiKey;
    const effectiveCwd = ctx?.cwd || undefined;
    let configPath: string | null = null;
    let configPathIsTemp = false;
    try {
      const descriptor = this.#adapter.buildOneshotSpawn({
        rolePrompt: spec.rolePrompt || '',
        taskText: spec.taskText,
        mcpConfigPath: null,
      });

      if (descriptor.needsMcpConfig) {
        if (ctx?.mcp_config_path) {
          configPath = ctx.mcp_config_path;
          configPathIsTemp = false;
        } else {
          configPath = join(
            this.#pidDir,
            `cfg-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
          );
          configPathIsTemp = true;
          await fsp.mkdir(dirname(configPath), { recursive: true, mode: 0o700 });

          const mcpConfig = {
            mcpServers: {
              awb: {
                type: 'http',
                url: `${this.#config.url.replace(/\/$/, '')}/mcp`,
                headers: {
                  Authorization: `Bearer ${effectiveApiKey}`,
                  'X-AWB-Client-Type': 'subagent',
                },
              },
            },
          };
          await fsp.writeFile(configPath, JSON.stringify(mcpConfig), { mode: 0o600 });
        }

        Object.assign(
          descriptor,
          this.#adapter.buildOneshotSpawn({
            rolePrompt: spec.rolePrompt || '',
            taskText: spec.taskText,
            mcpConfigPath: configPath,
          }),
        );
      }

      const resolvedBin = this.#adapter.resolveBin(this.#config.delegation.claudeBin);
      const child = spawn(resolvedBin, descriptor.args, {
        stdio: descriptor.stdio || ['ignore', 'pipe', 'pipe'],
        detached: true,
        windowsHide: true,
        cwd: effectiveCwd,
        env: { ...process.env, AWB_API_KEY: effectiveApiKey },
        shell: descriptor.shell ?? /\.(cmd|bat|ps1)$/i.test(resolvedBin),
      });
      child.once('error', (err: any) => {
        log(
          `Subagent spawn error: code=${err?.code || ''} cli=${this.#adapter.cliType} bin=${resolvedBin} msg=${err?.message}`,
        );
      });
      child.unref();

      const pid = child.pid;
      if (!pid) {
        if (configPath) await fsp.unlink(configPath).catch(() => {});
        this.#map.delete(reservationId);
        return { spawned: false, reason: 'spawn_failed' };
      }

      if (typeof descriptor.writePrompt === 'function') {
        try {
          descriptor.writePrompt(child);
        } catch (err: any) {
          log(`Subagent writePrompt failed: ${err?.message ?? err}`);
        }
      }

      const record: SubagentRecord = {
        pid,
        kind: spec.kind,
        cli_type: this.#adapter.cliType,
        trigger_id: spec.triggerId || null,
        chat_request_id: spec.chatRequestId || null,
        ticket_id: spec.ticketId || null,
        agent_id: spec.agentId || null,
        started_at: Date.now(),
        expected_completion_at:
          Date.now() + (this.#config.delegation.ttlMinutes ?? 15) * 60_000,
        config_path: configPath,
        config_path_is_temp: configPathIsTemp,
        process_handle: child,
        captureOutput: !this.#adapter.has(NATIVE_MCP),
        outLines: [],
        tap: null,
      };
      record.tap =
        this.#monitor?.register({
          kind: 'oneshot',
          sessionKey: spec.triggerId
            ? `oneshot:trigger:${spec.triggerId}`
            : spec.chatRequestId
              ? `oneshot:chat:${spec.chatRequestId}`
              : `oneshot:${pid}`,
          pid,
        }) || null;
      this.#map.delete(reservationId);
      this.#map.set(pid, record);
      this.#persist();

      this.#wireExitHandler(child, pid);
      this.#wireStdioCapture(child, pid);

      log(
        `Subagent spawned: pid=${pid} cli=${this.#adapter.cliType} kind=${spec.kind} ticket=${spec.ticketId || '-'}`,
      );
      return { spawned: true, pid };
    } catch (err: any) {
      this.#map.delete(reservationId);
      if (configPath && configPathIsTemp) {
        await fsp.unlink(configPath).catch(() => {});
      }
      log(`Subagent spawn error: ${err?.message ?? err}`);
      return { spawned: false, reason: 'exception' };
    }
  }

  #wireExitHandler(child: ChildProcess, pid: number): void {
    child.once('exit', async (code, signal) => {
      const record = this.#map.get(pid);
      if (!record || record.kind === 'reservation') return;
      const durationSec = Math.round((Date.now() - record.started_at) / 1000);
      this.#map.delete(pid);
      this.#persist();
      if (record.config_path && record.config_path_is_temp) {
        try {
          await fsp.unlink(record.config_path);
        } catch {
          /* best-effort */
        }
      }
      record.tap?.end({ exit_code: code, signal });

      if (record.captureOutput && record.ticket_id && code === 0 && !signal) {
        try {
          const answer = this.#adapter.collectOneshotResult(record.outLines);
          if (answer) await this.#postOneshotAnswer(record, answer);
        } catch (err: any) {
          log(`Subagent post-answer failed pid=${pid}: ${err?.message ?? err}`);
        }
      }

      log(
        `Subagent exit: pid=${pid} cli=${record.cli_type || '-'} kind=${record.kind} code=${code} signal=${signal || '-'} duration=${durationSec}s`,
      );
      if (typeof this.onExit === 'function') {
        try {
          this.onExit({ pid, record, code, signal, durationSec });
        } catch {
          /* ignore */
        }
      }
    });
    child.once('error', (err: any) => {
      log(`Subagent spawn error pid=${pid}: ${err?.message ?? err}`);
    });
  }

  #wireStdioCapture(child: ChildProcess, pid: number): void {
    // ST-6 follow-up: prefix log lines with the managed agent's short id when
    // we know one. Multi-tenant manager hosts spawn children for many agents
    // through a shared log stream, so without this you can't tell which
    // agent's subagent printed what. Falls back to bare `[subagent:<pid>]`
    // for the legacy single-agent case where agent_id is not set on the spawn
    // record.
    const tagFor = (record: SubagentRecord | undefined): string => {
      if (record && record.agent_id) {
        return `[subagent:${pid}][agent:${record.agent_id.slice(0, 8)}]`;
      }
      return `[subagent:${pid}]`;
    };

    if (child.stdout) {
      const rlOut = createInterface({ input: child.stdout });
      rlOut.on('line', (line) => {
        const rec = this.#map.get(pid);
        const record = rec && rec.kind !== 'reservation' ? (rec as SubagentRecord) : undefined;
        if (record) {
          record.tap?.outLine(line);
          if (record.captureOutput) {
            if (record.outLines.length < 10000) record.outLines.push(line);
          }
        }
        log(`${tagFor(record)} ${line}`);
      });
    }
    if (child.stderr) {
      const rlErr = createInterface({ input: child.stderr });
      rlErr.on('line', (line) => {
        const rec = this.#map.get(pid);
        const record = rec && rec.kind !== 'reservation' ? (rec as SubagentRecord) : undefined;
        log(`${tagFor(record)}[err] ${line}`);
      });
    }
  }

  async #postOneshotAnswer(record: SubagentRecord, answer: string): Promise<void> {
    const MAX = 60_000;
    const trimmed = answer.length > MAX ? answer.slice(0, MAX) + '\n\n…[truncated]' : answer;
    await fireAndForgetTool(this.#config, 'add_comment', {
      ticket_id: record.ticket_id,
      content: trimmed,
      type: 'note',
    });
    log(
      `Subagent posted answer to ticket=${record.ticket_id} (cli=${record.cli_type}, ${trimmed.length} chars)`,
    );
  }

  #sweep(): void {
    const now = Date.now();
    for (const [pid, record] of this.#map.entries()) {
      if (record.kind === 'reservation') continue;
      try {
        process.kill(pid, 0);
      } catch (err: any) {
        if (err?.code === 'ESRCH' || err?.code === 'EPERM') {
          log(`Sweep: pid=${pid} no longer alive, removing record`);
          this.#map.delete(pid);
          if (record.config_path && record.config_path_is_temp) {
            fsp.rm(dirname(record.config_path), { recursive: true, force: true }).catch(() => {});
          }
          continue;
        }
      }
      if (now >= record.expected_completion_at) {
        log(`Sweep: pid=${pid} exceeded TTL, sending SIGTERM`);
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          /* already dead */
        }
        setTimeout(() => {
          try {
            process.kill(pid, 0);
            log(`Sweep: pid=${pid} still alive after SIGTERM grace, sending SIGKILL`);
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              /* ignore */
            }
          } catch {
            /* already exited */
          }
        }, SIGTERM_GRACE_MS);
      }
    }
    this.#persist();
  }

  async #reconcileOnStart(): Promise<void> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.#persistPath, 'utf8');
    } catch {
      return;
    }
    let persisted: any[];
    try {
      persisted = JSON.parse(raw).pids || [];
    } catch {
      return;
    }

    let revived = 0,
      dropped = 0;
    for (const rec of persisted) {
      if (!rec || !rec.pid) continue;
      try {
        process.kill(rec.pid, 0);
        // Default `config_path_is_temp` to true for legacy persisted records
        // missing the field — that matches the pre-ST-6 cleanup behavior.
        this.#map.set(rec.pid, {
          ...rec,
          config_path_is_temp: rec.config_path_is_temp ?? true,
          process_handle: null,
          outLines: rec.outLines || [],
        });
        revived++;
      } catch (err: any) {
        if (err?.code === 'ESRCH' || err?.code === 'EPERM') dropped++;
      }
    }
    if (revived || dropped) {
      log(`SubagentManager reconciled: revived=${revived} dropped=${dropped}`);
    }
    this.#persist();
  }

  #persist(): void {
    const pids: any[] = [];
    for (const rec of this.#map.values()) {
      if (rec.kind === 'reservation') continue;
      const { process_handle, outLines, tap, ...serializable } = rec;
      void process_handle;
      void outLines;
      void tap;
      pids.push(serializable);
    }
    fsp
      .writeFile(this.#persistPath, JSON.stringify({ pids }, null, 2))
      .catch((err: any) => log(`SubagentManager persist failed: ${err?.message ?? err}`));
  }

  async stop(): Promise<void> {
    if (this.#sweepTimer) {
      clearInterval(this.#sweepTimer);
      this.#sweepTimer = null;
    }
    const pids: number[] = [];
    for (const [pid, rec] of this.#map.entries()) {
      if (rec.kind === 'reservation') continue;
      pids.push(pid);
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* dead */
      }
    }
    if (pids.length === 0) {
      this.#map.clear();
      return;
    }
    await new Promise((r) => setTimeout(r, STOP_GRACE_MS));
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    this.#map.clear();
    try {
      await fsp.writeFile(this.#persistPath, JSON.stringify({ pids: [] }, null, 2));
    } catch {
      /* best-effort */
    }
    log(`SubagentManager stopped (terminated ${pids.length} children)`);
  }

  _snapshot(): any[] {
    const out: any[] = [];
    for (const rec of this.#map.values()) {
      if (rec.kind === 'reservation') continue;
      const { process_handle, outLines, tap, ...serializable } = rec;
      void process_handle;
      void outLines;
      void tap;
      out.push(serializable);
    }
    return out;
  }
}
