import { Injectable } from '@nestjs/common';
import { Ticket } from '../entities/Ticket';

export type MentionType = 'user' | 'agent' | 'role';
export type RoleShortcut = 'assignee' | 'reporter' | 'reviewer';

export const ROLE_SHORTCUTS: readonly RoleShortcut[] = ['assignee', 'reporter', 'reviewer'];

/**
 * One parsed `@[type:id|name]` token. `id` is a UUID for user/agent mentions,
 * or the role keyword (`assignee` etc.) for role mentions.
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
  // Whether this came from a role shortcut (so the UI/prompt can say "as the assignee" etc.)
  roleShortcut?: RoleShortcut;
}

// Structured token grammar: @[<type>:<id>|<optional display name>]
// - type ∈ {user, agent, role}
// - id: UUID or role keyword; restrict to [\w-] to keep matching cheap
// - displayName: anything up to `]`; optional
const TOKEN_RE = /@\[(user|agent|role):([\w-]+)(?:\|([^\]]*))?\]/g;

@Injectable()
export class MentionService {
  /**
   * Extract all mention tokens from a piece of text. Deduped by (type, id).
   */
  parseMentions(text: string | null | undefined): MentionRef[] {
    if (!text) return [];
    const seen = new Set<string>();
    const out: MentionRef[] = [];
    // reset lastIndex since TOKEN_RE is /g
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
   * Resolve a role shortcut against a ticket.
   * Role shortcuts map to agent_id fields on the ticket (assignee_id/reporter_id/reviewer_id).
   * Returns null when the ticket has no agent assigned to that role.
   */
  resolveRoleShortcut(ticket: Ticket | null | undefined, shortcut: string): { type: 'agent'; id: string } | null {
    if (!ticket) return null;
    const lower = shortcut.toLowerCase() as RoleShortcut;
    if (!ROLE_SHORTCUTS.includes(lower)) return null;
    const field = `${lower}_id` as 'assignee_id' | 'reporter_id' | 'reviewer_id';
    const agentId = ticket[field];
    if (!agentId) return null;
    return { type: 'agent', id: agentId };
  }

  /**
   * Expand role refs to concrete user/agent refs using the ticket context.
   * Role refs with no resolution are dropped. user/agent refs pass through.
   * Deduped by (type, id) so one target is never notified twice per message.
   */
  resolveMentions(refs: MentionRef[], ticket: Ticket | null | undefined): ResolvedMention[] {
    const seen = new Set<string>();
    const out: ResolvedMention[] = [];
    for (const ref of refs) {
      if (ref.type === 'role') {
        const resolved = this.resolveRoleShortcut(ticket, ref.id);
        if (!resolved) continue;
        const key = `${resolved.type}:${resolved.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          type: resolved.type,
          id: resolved.id,
          displayName: ref.displayName,
          roleShortcut: ref.id.toLowerCase() as RoleShortcut,
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
