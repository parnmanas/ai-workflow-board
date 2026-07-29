import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChildRun } from '../../entities/ChildRun';

function boundedText(value: unknown, max: number): string {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .slice(0, max);
}

function boundedMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, 32)) {
    if (/token|secret|password|authorization|api.?key/i.test(key)) {
      result[key] = '[REDACTED]';
    } else if (typeof entry === 'string') {
      result[key] = boundedText(entry, 1_000);
    } else if (
      typeof entry === 'number'
      || typeof entry === 'boolean'
      || entry === null
    ) {
      result[key] = entry;
    }
  }
  return result;
}

@Injectable()
export class ChildRunService {
  constructor(
    @InjectRepository(ChildRun) private readonly childRuns: Repository<ChildRun>,
  ) {}

  list(workspaceId: string, parentRunId: string): Promise<ChildRun[]> {
    return this.childRuns.find({
      where: { workspace_id: workspaceId, parent_run_id: parentRunId },
      order: { started_at: 'ASC' },
      take: 250,
    });
  }

  listForAgent(workspaceId: string, agentId: string): Promise<ChildRun[]> {
    return this.childRuns.find({
      where: { workspace_id: workspaceId, parent_agent_id: agentId },
      order: { started_at: 'DESC' },
      take: 250,
    });
  }

  async start(args: {
    workspaceId: string;
    parentRunId: string;
    parentAgentId: string;
    childId: string;
    strategy: 'delegated' | 'swarm';
    depth?: number;
    budget?: number;
    title?: string;
    metadata?: unknown;
  }): Promise<ChildRun> {
    const identity = {
      workspace_id: boundedText(args.workspaceId, 128),
      parent_run_id: boundedText(args.parentRunId, 256),
      runtime_child_id: boundedText(args.childId, 160),
    };
    if (!identity.workspace_id || !identity.parent_run_id || !identity.runtime_child_id) {
      throw Object.assign(new Error('ChildRun identity is required'), {
        status: 400,
        code: 'child_run_identity_required',
      });
    }
    const existing = await this.childRuns.findOne({ where: identity });
    if (existing) return existing;
    return this.childRuns.save(this.childRuns.create({
      ...identity,
      parent_agent_id: boundedText(args.parentAgentId, 128),
      strategy: args.strategy,
      status: 'running',
      depth: Math.min(8, Math.max(1, Math.floor(args.depth ?? 1))),
      budget: Math.min(1_000_000, Math.max(0, Math.floor(args.budget ?? 0))),
      title: boundedText(args.title, 240),
      summary: '',
      runtime_metadata: boundedMetadata(args.metadata),
      started_at: new Date(),
      finished_at: null,
    }));
  }

  async finish(args: {
    workspaceId: string;
    parentRunId: string;
    childId: string;
    status: 'completed' | 'failed' | 'cancelled';
    summary?: string;
    metadata?: unknown;
  }): Promise<ChildRun> {
    const child = await this.childRuns.findOne({
      where: {
        workspace_id: args.workspaceId,
        parent_run_id: args.parentRunId,
        runtime_child_id: args.childId,
      },
    });
    if (!child) {
      throw Object.assign(new Error('ChildRun not found'), {
        status: 404,
        code: 'child_run_not_found',
      });
    }
    if (child.status !== 'running') return child;
    child.status = args.status;
    child.summary = boundedText(args.summary, 4_000);
    child.runtime_metadata = {
      ...child.runtime_metadata,
      ...boundedMetadata(args.metadata),
    };
    child.finished_at = new Date();
    return this.childRuns.save(child);
  }
}
