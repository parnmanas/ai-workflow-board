// ST-5b — manager-side registry of agent identities supervised by this
// awb-agent-manager process. Hydrated from agent_manager_command SSE
// (spawn_agent populates, stop_agent clears the live status, set_working_dir
// updates the path) and exposed to InstanceHeartbeat so each ping reports
// `agent_ids[]` and `working_dirs[]` to the server.
//
// Why a separate registry (rather than re-using SubagentManager state):
//   - SubagentManager is keyed by ticket+role and tracks short-lived
//     one-shot subagents launched in response to triggers/chats.
//   - ManagedAgentRegistry is keyed by Agent.id and tracks long-running
//     CLI processes the manager owns end-to-end. Different lifecycle,
//     different observability surface.
//
// Lifecycle of CLI child processes (claude/codex/antigravity) is intentionally
// stubbed in this iteration. The contract layer (recognise commands, mark
// state, ack the server) is what landed in ST-5b; the actual `spawn child
// process and stream its stdio` work is a follow-up — this file's API is
// designed to absorb it without changing callers.

import { log } from './logging.js';

export type ManagedAgentStatus = 'idle' | 'spawning' | 'running' | 'stopped' | 'error';

export interface ManagedAgentRecord {
  agent_id: string;
  name: string;
  cli: string;             // claude | codex | antigravity | custom
  working_dir: string;
  status: ManagedAgentStatus;
  pid: number | null;
  spawned_at: string | null;   // ISO
  stopped_at: string | null;   // ISO
  last_error: string | null;
}

export class ManagedAgentRegistry {
  #byId = new Map<string, ManagedAgentRecord>();

  list(): ManagedAgentRecord[] {
    return Array.from(this.#byId.values());
  }

  get(agentId: string): ManagedAgentRecord | null {
    return this.#byId.get(agentId) ?? null;
  }

  upsert(rec: Pick<ManagedAgentRecord, 'agent_id' | 'name' | 'cli' | 'working_dir'>): ManagedAgentRecord {
    const existing = this.#byId.get(rec.agent_id);
    if (existing) {
      existing.name = rec.name || existing.name;
      existing.cli = rec.cli || existing.cli;
      existing.working_dir = rec.working_dir || existing.working_dir;
      return existing;
    }
    const fresh: ManagedAgentRecord = {
      agent_id: rec.agent_id,
      name: rec.name || rec.agent_id.slice(0, 8),
      cli: rec.cli || 'claude',
      working_dir: rec.working_dir || '',
      status: 'idle',
      pid: null,
      spawned_at: null,
      stopped_at: null,
      last_error: null,
    };
    this.#byId.set(rec.agent_id, fresh);
    return fresh;
  }

  setWorkingDir(agentId: string, workingDir: string): ManagedAgentRecord | null {
    const rec = this.#byId.get(agentId);
    if (!rec) return null;
    rec.working_dir = workingDir;
    return rec;
  }

  /**
   * Mark a managed agent as running. Currently called by the (stubbed)
   * spawn path — once real CLI launching lands, this should be invoked by
   * the child-process supervisor when the cli reports ready.
   */
  markRunning(agentId: string, pid: number): ManagedAgentRecord | null {
    const rec = this.#byId.get(agentId);
    if (!rec) return null;
    rec.status = 'running';
    rec.pid = pid;
    rec.spawned_at = new Date().toISOString();
    rec.stopped_at = null;
    rec.last_error = null;
    return rec;
  }

  markStopped(agentId: string, reason?: string): ManagedAgentRecord | null {
    const rec = this.#byId.get(agentId);
    if (!rec) return null;
    rec.status = 'stopped';
    rec.pid = null;
    rec.stopped_at = new Date().toISOString();
    if (reason) rec.last_error = reason;
    return rec;
  }

  markError(agentId: string, message: string): ManagedAgentRecord | null {
    const rec = this.#byId.get(agentId);
    if (!rec) return null;
    rec.status = 'error';
    rec.last_error = message;
    log(`[managed-agent ${agentId.slice(0, 8)}] error: ${message}`);
    return rec;
  }

  liveAgentIds(): string[] {
    const out: string[] = [];
    for (const rec of this.#byId.values()) {
      if (rec.status === 'running' || rec.status === 'spawning') out.push(rec.agent_id);
    }
    return out;
  }

  workingDirs(): string[] {
    const seen = new Set<string>();
    for (const rec of this.#byId.values()) {
      if (rec.working_dir) seen.add(rec.working_dir);
    }
    return Array.from(seen);
  }
}
