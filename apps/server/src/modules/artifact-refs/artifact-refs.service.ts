import { Injectable } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Action, Ticket, WorkflowFunction, Account, AutomationSchedule } from '../../entities';
import { resolveCallerIdentityRow } from '../mcp/shared/authz';
import {
  ARTIFACT_REF_TYPES, ArtifactRefType, UUID_RE, formatArtifactRef, formatUnavailableArtifact, ticketPath,
} from '../../common/artifact-ref';
import { ReBACService } from '../../services/rebac.service';
import { AccountAccessService } from '../../services/account-access.service';

export interface ResolvedArtifactRef {
  type: ArtifactRefType;
  id: string;
  available: boolean;
  label: string;
  deepLink: string | null;
  accountName?: string;
  reason?: 'malformed_id' | 'account_access_denied' | 'not_found' | 'outside_account' | 'no_detail_surface';
}

@Injectable()
export class ArtifactRefsService {
  constructor(
    @InjectRepository(Ticket) private readonly tickets: Repository<Ticket>,
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(Action) private readonly actions: Repository<Action>,
    @InjectRepository(WorkflowFunction) private readonly functions: Repository<WorkflowFunction>,
    @InjectRepository(AutomationSchedule) private readonly schedules: Repository<AutomationSchedule>,
    @InjectRepository(Account) private readonly accounts: Repository<Account>,
    private readonly rebac: ReBACService,
    private readonly access: AccountAccessService,
  ) {}

  async resolveMany(
    user: { id: string; role: string },
    accountId: string,
    refs: Array<{ type: ArtifactRefType; id: string }>,
  ): Promise<ResolvedArtifactRef[]> {
    const allowedIds = await this.access.accessibleIds(user);
    return Promise.all(refs.slice(0, 100).map(ref =>
      this.resolveOne(ref, accountId, true, undefined, allowedIds),
    ));
  }

  async normalizeStoredOutput(accountId: string, text: string): Promise<string> {
    const tokenLike = /#\[(ticket|agent|action|function|schedule):([^|\]\r\n]+)\|([^\]\r\n]+)\]/gi;
    const matches = [...text.matchAll(tokenLike)];
    if (matches.length === 0) return text;
    let output = '';
    let cursor = 0;
    for (const match of matches) {
      output += text.slice(cursor, match.index);
      const type = match[1].toLowerCase() as ArtifactRefType;
      const id = match[2].trim();
      const resolved = await this.resolveOne({ type, id }, accountId, true);
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
    accountId: string,
    workspaceAllowed: boolean,
    accountName?: string,
    allowedAccountIds?: string[],
  ): Promise<ResolvedArtifactRef> {
    if (!ARTIFACT_REF_TYPES.includes(ref.type) || !UUID_RE.test(ref.id)) {
      return this.unavailable(ref.type, ref.id, 'malformed_id');
    }
    if (!workspaceAllowed) return this.unavailable(ref.type, ref.id, 'account_access_denied');

    let entity: any = null;
    let entityWorkspace: string | null = null;
    let label = '';
    let deepLink: string | null = null;
    if (ref.type === 'ticket') {
      entity = await this.tickets.findOne({ where: { id: ref.id } });
      entityWorkspace = entity?.account_id ?? null;
      label = entity?.title || '';
      deepLink = entity ? ticketPath(accountId, entity.id) : null;
    } else if (ref.type === 'agent') {
      // P4c-4: Host/링크 해소 (Agent 테이블 없음, agents UI 제거 — 딥링크 없음).
      const identity = await resolveCallerIdentityRow(this.dataSource, ref.id);
      entity = identity as any;
      entityWorkspace = identity?.account_id ?? accountId;
      label = identity?.name || '';
      deepLink = null;
    } else {
      const repo = ref.type === 'action' ? this.actions : ref.type === 'function' ? this.functions : this.schedules;
      entity = await repo.findOne({ where: { id: ref.id } as any });
      entityWorkspace = entity?.account_id ?? null;
      label = entity?.name || entity?.key || '';
      const surface = ref.type === 'action' ? 'actions' : ref.type === 'function' ? 'functions' : 'schedules';
      deepLink = entity ? `/${surface}?artifact=${entity.id}` : null;
    }
    if (!entity) return this.unavailable(ref.type, ref.id, 'not_found');
    if (allowedAccountIds) {
      if (entityWorkspace && !allowedAccountIds.includes(entityWorkspace)) return this.unavailable(ref.type, ref.id, 'account_access_denied');
      if (entityWorkspace) accountName = (await this.accounts.findOne({ where: { id: entityWorkspace } }))?.name;
    } else if (entityWorkspace !== accountId && !(ref.type === 'function' && entityWorkspace === null)) {
      return this.unavailable(ref.type, ref.id, 'outside_account');
    }
    if (!deepLink) {
      return { ...this.unavailable(ref.type, ref.id, 'no_detail_surface'), label, accountName };
    }
    return { type: ref.type, id: ref.id, available: true, label, deepLink, accountName };
  }
}
