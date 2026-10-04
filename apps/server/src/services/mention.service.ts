import { Injectable } from '@nestjs/common';
import { Ticket } from '../entities/Ticket';

export type MentionType = 'user' | 'agent';

/**
 * One parsed `@[type:id|name]` token. `id` is a user UUID or an agent id.
 */
export interface MentionRef {
  type: MentionType;
  id: string;
  displayName?: string;
}

/** A mention after self-exclusion and de-duplication — concrete target of a notification. */
export interface ResolvedMention {
  type: 'user' | 'agent';
  id: string;
  displayName?: string;
}

// Structured token grammar: @[<type>:<id>|<optional display name>]
// - type ∈ {user, agent}
// - id: UUID / agent id; restrict to [\w-] to keep matching cheap
// - displayName: anything up to `]`; optional
//
// `@[role:<slug>]` shortcuts are gone with workspace roles (docs/tickets.md):
// a ticket has exactly one assignee agent and no role holders to fan out to.
// An old role token in stored text no longer matches and stays plain text.
const TOKEN_RE = /@\[(user|agent):([\w-]+)(?:\|([^\]]*))?\]/g;

/** Parses `@[…]` tokens and narrows them to the concrete targets to notify. */
@Injectable()
export class MentionService {
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
   * Narrow parsed refs to notification targets. Deduped by (type, id).
   *
   * Self-exclusion: when `opts.excludeActor` is supplied, the author is
   * dropped — a direct self `@[agent:<own-id>]` would otherwise send a
   * `comment_mention` SSE back to the author, and agent-manager would
   * re-spawn the author's own subagent (a recursive loop). Every dispatch
   * path passes its resolved author; the chat path used to omit it, which let
   * a sender persist a UserMention row addressed to themselves.
   *
   * `ticket` is unused now that role shortcuts are gone; it stays in the
   * signature so the comment/chat call sites keep one shape.
   */
  async resolveMentions(
    refs: MentionRef[],
    _ticket?: Ticket | null,
    opts?: { excludeActor?: { type: 'user' | 'agent'; id: string } | null },
  ): Promise<ResolvedMention[]> {
    const exclude = opts?.excludeActor ?? null;
    const seen = new Set<string>();
    const out: ResolvedMention[] = [];
    for (const ref of refs) {
      if (exclude && exclude.type === ref.type && exclude.id === ref.id) continue;
      const key = `${ref.type}:${ref.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ type: ref.type, id: ref.id, displayName: ref.displayName });
    }
    return out;
  }
}
