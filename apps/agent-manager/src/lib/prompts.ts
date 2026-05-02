// Prompt composers — pure, side-effect-free functions that assemble the
// positional prompt text handed to CLI subagents. Implementations of the
// PromptComposer interface declared in event-dispatcher.ts.
//
// role_prompt is NEVER baked in here; it is injected separately via
// --append-system-prompt (claude) at spawn time.

import type { ColumnPrompt, PromptComposer } from './event-dispatcher.js';

interface CommentLike {
  author_name?: string;
  agent_name?: string;
  body?: string;
  content?: string;
  created_at?: string;
}

interface MentionLike {
  actor_name?: string;
  mention_source?: string;
  role_shortcut?: string;
  ticket_id?: string;
  content?: string;
}

interface ChatHistoryEntry {
  sender_type?: string;
  sender_name?: string;
  sender_id?: string;
  content?: string;
  created_at?: string;
}

interface ChatRoomNewMessage {
  content?: string;
  sender_name?: string;
  sender_id?: string;
}

export function composeTriggerPrompt(
  ticket: any,
  _rolePrompt: string,
  ticketPrompt: string,
  fallbackTicketId: string,
  columnPrompt: ColumnPrompt | null,
  extraInstructions?: string | null,
): string {
  const lines: string[] = [];
  lines.push('You are an AWB subagent responding to an assigned trigger.');
  lines.push('');
  if (ticket) {
    lines.push(`Ticket ID: ${ticket.id}`);
    if (ticket.title) lines.push(`Title: ${ticket.title}`);
    if (ticket.description) {
      lines.push('');
      lines.push('Description:');
      lines.push(ticket.description);
    }
    if (columnPrompt && columnPrompt.content) {
      lines.push('');
      lines.push(`Column workflow guide (${columnPrompt.name || 'column_prompt'}):`);
      lines.push(columnPrompt.content);
    }
    if (ticketPrompt) {
      lines.push('');
      lines.push('Ticket instructions:');
      lines.push(ticketPrompt);
    } else if (ticket.prompt_text) {
      lines.push('');
      lines.push('Ticket instructions:');
      lines.push(ticket.prompt_text);
    }
    const comments: CommentLike[] = Array.isArray(ticket.comments)
      ? ticket.comments.slice(-5)
      : [];
    if (comments.length > 0) {
      lines.push('');
      lines.push('Recent comments (newest last):');
      for (const c of comments) {
        const who = c.author_name || c.agent_name || 'unknown';
        const when = c.created_at || '';
        const body = (c.body || c.content || '').slice(0, 2000);
        lines.push(`- [${when}] ${who}: ${body}`);
      }
    }
  } else {
    lines.push(`Ticket ID: ${fallbackTicketId || 'unknown'}`);
    lines.push('(Fresh ticket context fetch failed — using embedded trigger payload only.)');
    if (columnPrompt && columnPrompt.content) {
      lines.push('');
      lines.push(`Column workflow guide (${columnPrompt.name || 'column_prompt'}):`);
      lines.push(columnPrompt.content);
    }
    if (ticketPrompt) {
      lines.push('');
      lines.push('Ticket instructions:');
      lines.push(ticketPrompt);
    }
  }
  lines.push('');
  lines.push('Instructions:');
  lines.push('- Use AWB MCP tools (mcp__awb__*) to perform the work.');
  lines.push('- Claim the ticket if not already claimed.');
  lines.push('- Leave a comment on the ticket when done describing what you did.');
  lines.push('- Move the ticket to the next column when the work is complete.');
  if (extraInstructions) {
    lines.push('');
    lines.push(extraInstructions);
  }
  return lines.join('\n');
}

export function composeChatPrompt(
  _rolePrompt: string,
  history: ChatHistoryEntry[],
  newMessage: string,
): string {
  const lines: string[] = [];
  lines.push('You are an AWB chat subagent responding to a user message in a live conversation.');
  lines.push('');
  if (Array.isArray(history) && history.length > 0) {
    lines.push('Conversation history (oldest first):');
    for (const h of history.slice(-20)) {
      const who = h.sender_type === 'agent' ? 'Agent' : 'User';
      const when = h.created_at || '';
      const content = (h.content || '').slice(0, 2000);
      lines.push(`- [${when}] ${who}: ${content}`);
    }
    lines.push('');
  }
  lines.push('Latest user message:');
  lines.push(newMessage || '');
  lines.push('');
  lines.push('Instructions:');
  lines.push('- Compose a helpful reply using your knowledge and the conversation context.');
  lines.push('- Reply ONLY via the mcp__awb__send_chat_room_message MCP tool (pass the room_id from the chat request context).');
  lines.push('- Do NOT print your reply to stdout — it must go through send_chat_room_message so the user sees it in the web UI.');
  return lines.join('\n');
}

export function composeCommentMentionPrompt(
  ticket: any,
  _rolePrompt: string,
  mention: MentionLike,
  fallbackTicketId: string,
): string {
  const lines: string[] = [];
  lines.push('⚠️ You were @-mentioned in a comment. This message is addressed to YOU specifically — respond directly.');
  lines.push('');
  if (mention.actor_name) {
    lines.push(`Mentioned by: ${mention.actor_name}`);
  }
  if (mention.mention_source === 'role' && mention.role_shortcut) {
    lines.push(`Via role shortcut: @${mention.role_shortcut}`);
  }
  lines.push('');
  if (ticket) {
    lines.push(`Ticket ID: ${ticket.id}`);
    if (ticket.title) lines.push(`Title: ${ticket.title}`);
    if (ticket.description) {
      lines.push('');
      lines.push('Description:');
      lines.push(ticket.description);
    }
  } else {
    lines.push(`Ticket ID: ${fallbackTicketId || mention.ticket_id || 'unknown'}`);
    lines.push('(Fresh ticket context fetch failed — using the mention payload only.)');
  }
  lines.push('');
  lines.push('Comment body addressed to you:');
  lines.push(mention.content || '');
  lines.push('');
  lines.push('Instructions:');
  lines.push('- Read the comment and respond to the request directly.');
  lines.push('- Use AWB MCP tools (mcp__awb__*) to take action if the comment asks for work.');
  lines.push('- Leave a reply comment on the ticket addressing the user who mentioned you.');
  lines.push('- Do NOT ignore this — the comment is explicitly addressed to you via @-mention.');
  return lines.join('\n');
}

export function composeChatRoomPrompt(
  roomId: string,
  history: ChatHistoryEntry[],
  newMessage: ChatRoomNewMessage,
): string {
  const lines: string[] = [];
  lines.push('You are an AWB chat subagent responding to a user message in a chat room.');
  lines.push('');
  lines.push(`Room ID: ${roomId}`);
  lines.push('');
  if (Array.isArray(history) && history.length > 0) {
    lines.push('Conversation history (oldest first):');
    for (const h of history.slice(-20)) {
      const who = h.sender_type === 'agent' ? 'Agent' : 'User';
      const name = h.sender_name || h.sender_id || 'unknown';
      const when = h.created_at || '';
      const content = (h.content || '').slice(0, 2000);
      lines.push(`- [${when}] ${who} (${name}): ${content}`);
    }
    lines.push('');
  }
  lines.push('Latest user message:');
  lines.push(newMessage.content || '');
  lines.push(`From: ${newMessage.sender_name || newMessage.sender_id || 'unknown'}`);
  lines.push('');
  lines.push('Instructions:');
  lines.push('- Compose a helpful reply using your knowledge and the conversation context.');
  lines.push(`- Reply ONLY via the mcp__awb__send_chat_room_message MCP tool (room_id: "${roomId}").`);
  lines.push('- Do NOT print your reply to stdout — it must go through send_chat_room_message so the user sees it in the web UI.');
  return lines.join('\n');
}

export const promptComposer: PromptComposer = {
  composeTriggerPrompt,
  composeChatPrompt,
  composeChatRoomPrompt,
  composeCommentMentionPrompt,
};
