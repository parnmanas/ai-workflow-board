import { Injectable } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Repository } from 'typeorm';
import { AgentErrorLog } from '../../entities/AgentErrorLog';
import { resolveAgentDisplayNamesByIds } from '../../utils/agent-name';

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
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async ingestEntries(
    agentId: string,
    accountId: string | null,
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
        account_id: accountId,
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

    // P4c-4: Agent.last_error_upload_at monotonic 마킹 제거 (Agent 테이블 없음 —
    // 에러 로그 행 자체가 소스다).
    void maxOccurredAt;

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

    // Join agent names in one query, then format with Manager/Agent prefix
    // so the log table shows the same identity the rest of the UI does.
    // P4c-4: Host/링크 이름으로 해소한다 (Agent 테이블 없음).
    const agentIds = Array.from(new Set(rows.map(r => r.agent_id)));
    const agentNameMap = await resolveAgentDisplayNamesByIds(this.dataSource, agentIds);

    return rows.map(r => ({
      id: r.id,
      agent_id: r.agent_id,
      agent_name: agentNameMap.get(r.agent_id) || null,
      account_id: r.account_id,
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

  // Count error-level entries since the given cutoff. NULL cutoff counts
  // all-time errors, which only makes sense on a user's first visit before
  // the client has stored a last-seen timestamp; subsequent polls always
  // pass one. Matches the UI filter default ("errors only" badge, not warn).
  async countSince(since: Date | null): Promise<number> {
    const qb = this.repo.createQueryBuilder('l').where("l.level IN ('error', 'fatal')");
    if (since && !Number.isNaN(since.getTime())) {
      qb.andWhere('l.occurred_at > :since', { since });
    }
    return qb.getCount();
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

    // P4c-4: Host/링크 이름으로 해소한다 (Agent 테이블 없음).
    const agentIds = raw.map(r => r.agent_id);
    const nameMap = await resolveAgentDisplayNamesByIds(this.dataSource, agentIds);

    return raw.map(r => ({
      agent_id: r.agent_id,
      agent_name: nameMap.get(r.agent_id) || null,
      error_count: parseInt(r.error_count, 10) || 0,
    }));
  }
}
