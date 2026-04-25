import { Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Ticket } from '../entities/Ticket';
import { WorkspaceRole } from '../entities/WorkspaceRole';
import { TicketRoleAssignment } from '../entities/TicketRoleAssignment';

export type MentionType = 'user' | 'agent' | 'role';

/** Slug of a workflow role (formerly hardcoded as 'assignee'|'reporter'|'reviewer'). */
export type RoleShortcut = string;

/**
 * One parsed `@[type:id|name]` token. `id` is a UUID for user/agent mentions,
 * or the role slug for role mentions.
 */
export interface MentionRef {
  type: MentionType;
  id: string;
  displayName?: string;
}

/**
 * A mention after role expansion — concrete target of a notification.
 * Role refs that can't be resolved on the given ticket are dropped before resolution.
 */
export interface ResolvedMention {
  type: 'user' | 'agent';
  id: string;
  displayName?: string;
  /** Slug of the workspace role this resolved from (e.g., 'assignee', 'qa-reviewer'). */
  roleShortcut?: RoleShortcut;
}

// Structured token grammar: @[<type>:<id>|<optional display name>]
// - type ∈ {user, agent, role}
// - id: UUID or role slug; restrict to [\w-] to keep matching cheap
// - displayName: anything up to `]`; optional
const TOKEN_RE = /@\[(user|agent|role):([\w-]+)(?:\|([^\]]*))?\]/g;

/**
 * Parses `@[…]` tokens and (when DB repos are injected) expands `role:` refs
 * to concrete (agent|user) targets using the v0.34 workspace-role tables.
 *
 * Resolution path for a role token on ticket T (in workspace W):
 *   1. Find `WorkspaceRole` where `(workspace_id=W, slug=shortcut)`.
 *   2. Find `TicketRoleAssignment` where `(ticket_id=T, role_id=role.id)`.
 *   3. Yield the holder (agent or user) — drop if no match.
 *
 * Pre-v0.34 the logic walked `ticket.assignee_id` / `reporter_id` /
 * `reviewer_id` columns directly with a hardcoded slug list. Those columns
 * are still on the entity for back-compat during the migration window but
 * are no longer the source of truth for mention resolution.
 *
 * Standalone (non-NestJS) usage may construct `MentionService` without
 * repositories; role resolution then short-circuits to null and only
 * direct user/agent mentions resolve.
 */
@Injectable()
export class MentionService {
  constructor(
    @Optional()
    @InjectRepository(WorkspaceRole)
    private readonly roleRepo?: Repository<WorkspaceRole>,

    @Optional()
    @InjectRepository(TicketRoleAssignment)
    private readonly assignRepo?: Repository<TicketRoleAssignment>,
  ) {}

  /** Extract all mention tokens from text. Deduped by (type, id). */
  parseMentions(text: string | null | undefined): MentionRef[] {
    if (!text) return [];
    const seen = new Set<string>();
    const out: MentionRef[] = [];
    TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TOKEN_RE.exec(text)) !== null) {
      const type = m[1] as MentionType;
      const id = m[2];
      const displayName = m[3];
      const key = `${type}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ type, id, displayName });
    }
    return out;
  }

  /**
   * Resolve a role slug against a ticket via workspace_roles +
   * ticket_role_assignments. Returns the holder (agent or user) or null.
   *
   * Returns null (instead of the legacy agent-only path) when:
   *   - no repos injected (standalone mode)
   *   - ticket has no workspace_id
   *   - workspace has no role with that slug
   *   - the ticket has no holder for that role
   */
  async resolveRoleShortcut(
    ticket: Ticket | null | undefined,
    shortcut: string,
  ): Promise<{ type: 'agent' | 'user'; id: string } | null> {
    if (!ticket || !ticket.workspace_id) return null;
    if (!this.roleRepo || !this.assignRepo) return null;
    const role = await this.roleRepo.findOne({
      where: { workspace_id: ticket.workspace_id, slug: shortcut },
    });
    if (!role) return null;
    const assignment = await this.assignRepo.findOne({
      where: { ticket_id: ticket.id, role_id: role.id },
    });
    if (!assignment) return null;
    if (assignment.agent_id) return { type: 'agent', id: assignment.agent_id };
    if (assignment.user_id) return { type: 'user', id: assignment.user_id };
    return null;
  }

  /**
   * Expand role refs to concrete user/agent refs using the ticket context.
   * user/agent refs pass through unchanged. Deduped by (type, id).
   */
  async resolveMentions(
    refs: MentionRef[],
    ticket: Ticket | null | undefined,
  ): Promise<ResolvedMention[]> {
    const seen = new Set<string>();
    const out: ResolvedMention[] = [];
    for (const ref of refs) {
      if (ref.type === 'role') {
        const resolved = await this.resolveRoleShortcut(ticket, ref.id);
        if (!resolved) continue;
        const key = `${resolved.type}:${resolved.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          type: resolved.type,
          id: resolved.id,
          displayName: ref.displayName,
          roleShortcut: ref.id,
        });
      } else {
        const key = `${ref.type}:${ref.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ type: ref.type, id: ref.id, displayName: ref.displayName });
      }
    }
    return out;
  }
}
