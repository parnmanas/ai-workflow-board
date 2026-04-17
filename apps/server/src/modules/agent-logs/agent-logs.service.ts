import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentErrorLog } from '../../entities/AgentErrorLog';
import { Agent } from '../../entities/Agent';

const MAX_ENTRIES_PER_UPLOAD = 500;
const MAX_LIST_LIMIT = 500;
const DEFAULT_LIST_LIMIT = 100;

function makeError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

interface IncomingEntry {
  occurred_at: string;
  level: string;
  category: string;
  message: string;
  raw_line?: string | null;
  pid?: string | null;
}

interface ListOpts {
  agent_id?: string;
  level?: string;
  category?: string;
  since?: Date;
  until?: Date;
  limit?: number;
}

@Injectable()
export class AgentLogsService {
  constructor(
    @InjectRepository(AgentErrorLog) private readonly repo: Repository<AgentErrorLog>,
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
  ) {}

  async ingestEntries(
    agentId: string,
    workspaceId: string | null,
    pluginVersion: string | null,
    entries: IncomingEntry[],
  ): Promise<{ accepted: number; uploaded_at: string; last_occurred_at: string | null }> {
    if (!Array.isArray(entries)) {
      throw makeError(400, 'entries must be an array');
    }
    if (entries.length === 0) {
      const uploadedAt = new Date();
      return { accepted: 0, uploaded_at: uploadedAt.toISOString(), last_occurred_at: null };
    }
    if (entries.length > MAX_ENTRIES_PER_UPLOAD) {
      throw makeError(400, `entries exceeds max of ${MAX_ENTRIES_PER_UPLOAD}`);
    }

    const rows: Partial<AgentErrorLog>[] = [];
    let maxOccurredAt: Date | null = null;

    for (const e of entries) {
      if (!e || typeof e !== 'object') {
        throw makeError(400, 'invalid entry: not an object');
      }
      if (!e.occurred_at || !e.level || !e.category || !e.message) {
        throw makeError(400, 'entry missing required fields (occurred_at/level/category/message)');
      }
      const occurredAt = new Date(e.occurred_at);
      if (isNaN(occurredAt.getTime())) {
        throw makeError(400, `invalid occurred_at: ${e.occurred_at}`);
      }
      if (!maxOccurredAt || occurredAt > maxOccurredAt) {
        maxOccurredAt = occurredAt;
      }
      rows.push({
        agent_id: agentId,
        workspace_id: workspaceId,
        occurred_at: occurredAt,
        level: String(e.level),
        category: String(e.category),
        message: String(e.message),
        raw_line: e.raw_line != null ? String(e.raw_line) : null,
        pid: e.pid != null ? String(e.pid) : null,
        plugin_version: pluginVersion,
      });
    }

    await this.repo.insert(rows);

    // Monotonic update of Agent.last_error_upload_at — only advance if greater
    if (maxOccurredAt) {
      const agent = await this.agentRepo.findOne({ where: { id: agentId } });
      if (agent) {
        const current = agent.last_error_upload_at ? new Date(agent.last_error_upload_at) : null;
        if (!current || maxOccurredAt > current) {
          agent.last_error_upload_at = maxOccurredAt;
          await this.agentRepo.save(agent);
        }
      }
    }

    const uploadedAt = new Date();
    return {
      accepted: rows.length,
      uploaded_at: uploadedAt.toISOString(),
      last_occurred_at: maxOccurredAt ? maxOccurredAt.toISOString() : null,
    };
  }

  async list(opts: ListOpts): Promise<any[]> {
    const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
    const qb = this.repo.createQueryBuilder('log');

    if (opts.agent_id) qb.andWhere('log.agent_id = :agent_id', { agent_id: opts.agent_id });
    if (opts.level) qb.andWhere('log.level = :level', { level: opts.level });
    if (opts.category) qb.andWhere('log.category = :category', { category: opts.category });
    if (opts.since) qb.andWhere('log.occurred_at >= :since', { since: opts.since });
    if (opts.until) qb.andWhere('log.occurred_at <= :until', { until: opts.until });

    qb.orderBy('log.occurred_at', 'DESC').limit(limit);
    const rows = await qb.getMany();

    // Join agent names in one query
    const agentIds = Array.from(new Set(rows.map(r => r.agent_id)));
    const agents = agentIds.length > 0
      ? await this.agentRepo.createQueryBuilder('a').where('a.id IN (:...ids)', { ids: agentIds }).getMany()
      : [];
    const agentNameMap = new Map(agents.map(a => [a.id, a.name]));

    return rows.map(r => ({
      id: r.id,
      agent_id: r.agent_id,
      agent_name: agentNameMap.get(r.agent_id) || null,
      workspace_id: r.workspace_id,
      occurred_at: r.occurred_at,
      level: r.level,
      category: r.category,
      message: r.message,
      raw_line: r.raw_line,
      pid: r.pid,
      plugin_version: r.plugin_version,
      created_at: r.created_at,
    }));
  }

  async listAgentsWithRecentErrors(days = 7): Promise<{ agent_id: string; agent_name: string | null; error_count: number }[]> {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const raw = await this.repo
      .createQueryBuilder('log')
      .select('log.agent_id', 'agent_id')
      .addSelect('COUNT(*)', 'error_count')
      .where('log.occurred_at >= :since', { since })
      .groupBy('log.agent_id')
      .getRawMany();

    const agentIds = raw.map(r => r.agent_id);
    const agents = agentIds.length > 0
      ? await this.agentRepo.createQueryBuilder('a').where('a.id IN (:...ids)', { ids: agentIds }).getMany()
      : [];
    const nameMap = new Map(agents.map(a => [a.id, a.name]));

    return raw.map(r => ({
      agent_id: r.agent_id,
      agent_name: nameMap.get(r.agent_id) || null,
      error_count: parseInt(r.error_count, 10) || 0,
    }));
  }
}
