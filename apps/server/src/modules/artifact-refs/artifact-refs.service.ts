import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Action, Agent, Board, BoardColumn, Ticket, WorkflowFunction, Workspace, WorkspaceSchedule } from '../../entities';
import {
  ARTIFACT_REF_TYPES, ArtifactRefType, UUID_RE, formatArtifactRef, formatUnavailableArtifact,
} from '../../common/artifact-ref';
import { ReBACService } from '../../services/rebac.service';

export interface ResolvedArtifactRef {
  type: ArtifactRefType;
  id: string;
  available: boolean;
  label: string;
  deepLink: string | null;
  workspaceName?: string;
  boardName?: string;
  reason?: 'malformed_id' | 'workspace_access_denied' | 'not_found' | 'outside_workspace' | 'no_detail_surface';
}

@Injectable()
export class ArtifactRefsService {
  constructor(
    @InjectRepository(Ticket) private readonly tickets: Repository<Ticket>,
    @InjectRepository(Agent) private readonly agents: Repository<Agent>,
    @InjectRepository(Board) private readonly boards: Repository<Board>,
    @InjectRepository(BoardColumn) private readonly columns: Repository<BoardColumn>,
    @InjectRepository(Action) private readonly actions: Repository<Action>,
    @InjectRepository(WorkflowFunction) private readonly functions: Repository<WorkflowFunction>,
    @InjectRepository(WorkspaceSchedule) private readonly schedules: Repository<WorkspaceSchedule>,
    @InjectRepository(Workspace) private readonly workspaces: Repository<Workspace>,
    private readonly rebac: ReBACService,
  ) {}

  async resolveMany(
    user: { id: string; role: string },
    workspaceId: string,
    refs: Array<{ type: ArtifactRefType; id: string }>,
  ): Promise<ResolvedArtifactRef[]> {
    const allowed = !!workspaceId && (user.role === 'admin' ||
      await this.rebac.check({ type: 'user', id: user.id }, 'owner', { type: 'workspace', id: workspaceId }) ||
      await this.rebac.check({ type: 'user', id: user.id }, 'member', { type: 'workspace', id: workspaceId }));
    const workspace = allowed
      ? await this.workspaces.findOne({ where: { id: workspaceId } })
      : null;
    return Promise.all(refs.slice(0, 100).map(ref =>
      this.resolveOne(ref, workspaceId, allowed, workspace?.name),
    ));
  }

  async normalizeStoredOutput(workspaceId: string, text: string): Promise<string> {
    const tokenLike = /#\[(ticket|agent|board|action|function|schedule):([^|\]\r\n]+)\|([^\]\r\n]+)\]/gi;
    const matches = [...text.matchAll(tokenLike)];
    if (matches.length === 0) return text;
    let output = '';
    let cursor = 0;
    for (const match of matches) {
      output += text.slice(cursor, match.index);
      const type = match[1].toLowerCase() as ArtifactRefType;
      const id = match[2].trim();
      const resolved = await this.resolveOne({ type, id }, workspaceId, true);
      output += resolved.available
        ? formatArtifactRef(type, id, resolved.label)
        : formatUnavailableArtifact(type, id, match[3], resolved.reason || '존재하지 않거나 권한 없음');
      cursor = (match.index || 0) + match[0].length;
    }
    return output + text.slice(cursor);
  }

  private unavailable(type: ArtifactRefType, id: string, reason: ResolvedArtifactRef['reason']): ResolvedArtifactRef {
    return { type, id, available: false, label: type, deepLink: null, reason };
  }

  private async resolveOne(
    ref: { type: ArtifactRefType; id: string },
    workspaceId: string,
    workspaceAllowed: boolean,
    workspaceName?: string,
  ): Promise<ResolvedArtifactRef> {
    if (!ARTIFACT_REF_TYPES.includes(ref.type) || !UUID_RE.test(ref.id)) {
      return this.unavailable(ref.type, ref.id, 'malformed_id');
    }
    if (!workspaceAllowed) return this.unavailable(ref.type, ref.id, 'workspace_access_denied');

    let entity: any = null;
    let entityWorkspace: string | null = null;
    let label = '';
    let deepLink: string | null = null;
    let boardName: string | undefined;
    if (ref.type === 'ticket') {
      entity = await this.tickets.findOne({ where: { id: ref.id } });
      entityWorkspace = entity?.workspace_id ?? null;
      label = entity?.title || '';
      if (entity) {
        const column = await this.columns.findOne({ where: { id: entity.column_id } });
        if (column?.board_id) {
          const board = await this.boards.findOne({ where: { id: column.board_id } });
          boardName = board?.name;
          deepLink = `/ws/${workspaceId}/boards/${column.board_id}?ticket=${entity.id}`;
        }
      }
    } else if (ref.type === 'agent') {
      entity = await this.agents.findOne({ where: { id: ref.id } });
      entityWorkspace = entity?.workspace_id ?? workspaceId;
      label = entity?.name || '';
      deepLink = entity ? `/ws/${workspaceId}/agents/${entity.id}` : null;
    } else if (ref.type === 'board') {
      entity = await this.boards.findOne({ where: { id: ref.id } });
      entityWorkspace = entity?.workspace_id ?? null;
      label = entity?.name || '';
      boardName = entity?.name;
      deepLink = entity ? `/ws/${workspaceId}/boards/${entity.id}` : null;
    } else {
      const repo = ref.type === 'action' ? this.actions : ref.type === 'function' ? this.functions : this.schedules;
      entity = await repo.findOne({ where: { id: ref.id } as any });
      entityWorkspace = entity?.workspace_id ?? (ref.type === 'function' && entity ? workspaceId : null);
      label = entity?.name || entity?.key || '';
      if (entity?.board_id) {
        const board = await this.boards.findOne({ where: { id: entity.board_id } });
        boardName = board?.name;
      }
      const surface = ref.type === 'action' ? 'actions' : ref.type === 'function' ? 'functions' : 'schedules';
      deepLink = entity ? `/ws/${workspaceId}/${surface}?artifact=${entity.id}` : null;
    }
    if (!entity) return this.unavailable(ref.type, ref.id, 'not_found');
    if (entityWorkspace !== workspaceId) {
      return this.unavailable(ref.type, ref.id, 'outside_workspace');
    }
    if (!deepLink) {
      return { ...this.unavailable(ref.type, ref.id, 'no_detail_surface'), label, workspaceName, boardName };
    }
    return { type: ref.type, id: ref.id, available: true, label, deepLink, workspaceName, boardName };
  }
}
