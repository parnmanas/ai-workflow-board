import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Agent } from '../entities/Agent';
import { activityEvents } from './activity.service';
import { LogService } from './log.service';

/**
 * Reverse-RPC bridge: web UI asks `FsBrowserService.request(...)` for an fs op
 * on a specific agent's machine. Service mints a request_id, emits an
 * `fs_request` SSE event scoped to that agent (delivered by EventsController
 * through the event-registry table), and returns a Promise that resolves when
 * the plugin POSTs back to `/api/fs/responses/:request_id`.
 *
 * Why this shape:
 * - Plugin already holds an outbound SSE connection to AWB; no new port
 *   needed on the agent machine (MCP direction would be wrong — agent→AWB,
 *   not AWB→agent).
 * - Response travels over a fresh HTTPS POST, not SSE, so large payloads
 *   (base64 file bytes, big directory listings) aren't squeezed through the
 *   event-stream framing.
 * - Path scope enforcement lives in the plugin (only it knows the machine's
 *   real filesystem layout); server is a pure forwarder.
 */

export type FsOp = 'list' | 'stat' | 'read' | 'roots';

export interface FsRootsResult {
  cwd: string;
  roots: string[];
  enabled: boolean;
}

export interface FsListEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  mtime: string;
  mode: number;
}

export interface FsListResult {
  path: string;
  entries: FsListEntry[];
  truncated: boolean;
}

export interface FsStatResult {
  path: string;
  real_path?: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  mtime: string;
  mode: number;
}

export interface FsReadResult {
  path: string;
  content: string;
  encoding: 'utf8' | 'base64';
  size: number;
  read_bytes: number;
  offset: number;
  truncated: boolean;
  mtime: string;
}

export interface FsPluginResponse {
  ok: boolean;
  data?: FsListResult | FsStatResult | FsReadResult | FsRootsResult;
  error?: string;
  code?: string;
}

interface PendingRequest {
  agent_id: string;
  op: FsOp;
  path?: string;
  created_at: number;
  resolve: (v: FsPluginResponse) => void;
  timer: NodeJS.Timeout;
}

// 15s is the UX sweet spot — plugin timestamps its own response, so a slow
// disk op is more likely the culprit than a stuck queue. A longer window
// would just delay the user's "agent offline / plugin stuck" feedback.
const REQUEST_TIMEOUT_MS = 15_000;
// Soft ceiling so a runaway caller can't pin unlimited RAM on request_id
// registry entries. Each pending entry is tiny (<1KB) but unbounded growth
// is still a liability if a buggy plugin never responds.
const MAX_PENDING = 500;

@Injectable()
export class FsBrowserService {
  private readonly pending = new Map<string, PendingRequest>();

  constructor(
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
    private readonly logService: LogService,
  ) {}

  async request(
    agentId: string,
    op: FsOp,
    args: { path?: string; offset?: number; limit?: number },
  ): Promise<FsPluginResponse> {
    const agent = await this.agentRepo.findOne({ where: { id: agentId } });
    if (!agent) throw new Error('Agent not found');
    if (!agent.is_online) throw new Error('Agent offline');

    if (this.pending.size >= MAX_PENDING) {
      throw new Error('Too many in-flight fs requests; try again shortly');
    }

    const requestId = randomUUID();

    const promise = new Promise<FsPluginResponse>((resolve) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(requestId);
        if (!entry) return;
        this.pending.delete(requestId);
        this.logService.warn('FsBrowser', `Request ${requestId} timed out (agent=${agentId} op=${op} path=${args.path})`);
        entry.resolve({ ok: false, error: 'Agent did not respond in time', code: 'TIMEOUT' });
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(requestId, {
        agent_id: agentId,
        op,
        path: args.path,
        created_at: Date.now(),
        resolve,
        timer,
      });
    });

    activityEvents.emit('fs_request', {
      request_id: requestId,
      agent_id: agentId,
      op,
      path: args.path,
      offset: args.offset,
      limit: args.limit,
      timestamp: new Date().toISOString(),
    });

    return promise;
  }

  /**
   * Called by the plugin-facing controller when the agent's proxy POSTs a
   * response. Agent ownership check prevents cross-agent spoofing — even a
   * valid API key from the wrong agent can't resolve someone else's pending.
   */
  resolveResponse(requestId: string, agentId: string, body: FsPluginResponse): { ok: boolean; reason?: string } {
    const entry = this.pending.get(requestId);
    if (!entry) return { ok: false, reason: 'Unknown or expired request_id' };
    if (entry.agent_id !== agentId) return { ok: false, reason: 'Request_id belongs to a different agent' };
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    entry.resolve(body);
    return { ok: true };
  }

  // Used by controllers for diagnostic logging and tests.
  get pendingCount(): number {
    return this.pending.size;
  }
}
