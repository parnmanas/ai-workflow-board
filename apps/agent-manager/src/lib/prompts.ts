// Prompt composers — pure, side-effect-free functions that assemble the
// positional prompt text handed to CLI subagents. Implementations of the
// PromptComposer interface declared in event-dispatcher.ts.
//
// role_prompt is NEVER baked in here; it is injected separately via
// --append-system-prompt (claude) at spawn time.

import type { ColumnPrompt, PromptComposer } from './event-dispatcher.js';
import {
  renderAttachmentBlock,
  type PreparedAttachment,
  type RawChatAttachment,
} from './chat-attachment-prep.js';

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
  /** Attachment metadata carried alongside the history message (server
   *  projects this on both the REST history endpoint and the SSE wire). The
   *  composer fetches/renders these so an image attached on a past turn
   *  survives a session respawn instead of being silently dropped. */
  attachments?: RawChatAttachment[];
  // 'progress' rows are agent-manager tool-call heartbeats. Defensive
  // belt-and-suspenders — both the SSE ring and the REST history endpoint
  // already strip them, but the composer also filters so any future caller
  // that hand-builds a history list can't accidentally narrate tool calls
  // back to the model.
  type?: string;
}

interface ChatRoomNewMessage {
  content?: string;
  sender_name?: string;
  sender_id?: string;
}

interface BaseRepoLike {
  id?: string;
  name?: string;
  url?: string;
  default_branch?: string;
}

/** Append a "Base repository" block to the trigger prompt when the ticket has
 *  a configured base_repo / base_branch. Tells the spawned subagent to fetch
 *  + check out that branch and cut its working branch from there, so every
 *  ticket starts from the latest known-good base instead of an unrelated
 *  checkout. Skipped silently when neither field
 *  is set, so non-code tickets don't carry git instructions they can't
 *  satisfy. */
function appendBaseRepoBlock(
  lines: string[],
  baseRepo: BaseRepoLike | null | undefined,
  baseBranch: string | null | undefined,
): void {
  const branch = (baseBranch || baseRepo?.default_branch || '').trim();
  if (!baseRepo && !branch) return;
  lines.push('');
  lines.push('Base repository:');
  if (baseRepo?.name) lines.push(`- Name: ${baseRepo.name}`);
  if (baseRepo?.url) lines.push(`- URL: ${baseRepo.url}`);
  if (branch) lines.push(`- Base branch: ${branch}`);
  lines.push('- The current work folder is the checkout prepared for this repository. Run `git fetch` there and check out the base branch (creating a fresh feature branch off it for your changes).');
}

/**
 * Work-folder placeholder token (worktree 규약 ④). The server bakes this literal
 * into every non-merging column workflow guide (default-prompt-templates.ts) and
 * ships only the working_dir-RELATIVE path (`worktree_rel_path` on the trigger
 * SSE) — it never knows the agent's absolute working_dir. agent-manager owns the
 * absolute-path render because it resolves the concrete spawn cwd.
 */
export const WORK_FOLDER_TOKEN = '{{AWB_WORK_FOLDER}}';

/**
 * Substitute the work-folder placeholder in a column-prompt content string with
 * the resolved absolute work folder (worktree 규약 ④), so the trigger prompt
 * names the exact directory the subagent is spawned in.
 *
 * Byte-identity guarantee: returns `content` UNCHANGED when the token is absent
 * (a pre-④ board's template, or the merging guide which intentionally omits it)
 * or when `workFolder` is empty — so boards that never opted in stay byte-for-
 * byte the same as before this feature.
 *
 * `workFolder` should be the resolved absolute cwd (`agentContext.cwd`); the
 * caller passes the relative path only as a last-resort fallback.
 */
export function injectWorkFolder(content: string, workFolder: string): string {
  if (!content || !workFolder || !content.includes(WORK_FOLDER_TOKEN)) return content;
  return content.split(WORK_FOLDER_TOKEN).join(workFolder);
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
    appendBaseRepoBlock(lines, ticket.base_repo ?? null, ticket.base_branch ?? null);
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

/** The delivery instruction for a chat reply depends on whether the responding
 *  CLI can call AWB MCP tools itself (NATIVE_MCP — claude) or whether the agent
 *  manager harvests its stdout and posts the reply on its behalf (non-NATIVE_MCP
 *  — codex / antigravity, where `captureOutput` is on). Telling a codex subagent
 *  to "reply via mcp__awb__send_chat_room_message" is doubly wrong: it has no
 *  such tool, and the "do NOT print to stdout" line starves the exact channel
 *  the manager reads. So the channel instruction has to track adapter capability.
 *
 *  When `usesNativeMcp` is true (default — preserves prior claude behavior) the
 *  subagent is told to call the MCP tool with the explicit room id. When false
 *  it is told to emit the reply as its final plain-text answer; the manager
 *  captures that and posts it to the room.
 *
 *  `isActionRoom` (ticket e6d32e9d) flips the WORK-POLICY line only — the reply
 *  CHANNEL lines are identical. An Action Run reuses the chat-room pipeline but
 *  its intent is the opposite of a chat: the message is a task the subagent must
 *  perform DIRECTLY, not defer into an AWB ticket. So for Action rooms we drop
 *  the "this is a CHAT channel, create a ticket" rule and substitute a
 *  "do the work directly, do NOT create a ticket" rule. Ordinary chat rooms
 *  (isActionRoom = false, the default) keep the prior behavior verbatim. */
function chatReplyInstructions(usesNativeMcp: boolean, roomId: string, isActionRoom = false): string[] {
  if (usesNativeMcp) {
    const lines = [
      `- Reply ONLY via the mcp__awb__send_chat_room_message MCP tool (room_id: "${roomId}").`,
      '- Do NOT print your reply to stdout — it must go through send_chat_room_message so the user sees it in the web UI.',
    ];
    if (isActionRoom) {
      lines.push(
        '- This is an ACTION run, NOT a chat. The message above is a task assigned specifically to YOU — carry it out DIRECTLY (code edits, feature implementation, bug fixes, refactors, migrations, config changes, and any committing/merging/branch work the task calls for). Do NOT create an AWB ticket to defer it and do NOT tell anyone to file one — you ARE the agent meant to do this work. Perform the requested task, then use send_chat_room_message to report your result / progress / summary.',
      );
    } else {
      lines.push(
        '- This is a CHAT channel, NOT a work channel. Do NOT perform development work directly here — no code edits, feature implementation, bug fixes, refactors, migrations, or config changes, and no committing/merging/branch surgery on the user\'s behalf. When the user asks for such work, create an AWB ticket with mcp__awb__create_ticket (leave roles unset so the board default assignees staff it) so the normal agent loop does the work, then reply with the ticket id/title. Answering questions, status/triage lookups, and light READ-ONLY investigation are the only things you do inline. If the user EXPLICITLY orders a direct action in this message, do it, but still prefer a ticket for anything substantive.',
      );
    }
    return lines;
  }
  const lines = [
    '- Reply with plain text as your final message. The agent manager captures your output and posts it to the chat room for you.',
    '- Do NOT try to call any MCP tool to send the reply — this runtime has no chat-send tool. Just write the reply text as your final answer.',
  ];
  if (isActionRoom) {
    lines.push(
      '- This is an ACTION run, NOT a chat. The message above is a task assigned specifically to YOU — carry it out DIRECTLY (code edits, fixes, refactors, migrations, config changes — whatever the task asks). Do NOT defer it to an AWB ticket; you are the agent meant to do this work. Write your result / summary as your final message.',
    );
  } else {
    lines.push(
      '- This is a CHAT channel, NOT a work channel. Do NOT perform development work directly here — no code edits, feature implementation, bug fixes, refactors, migrations, or config changes. When the user asks for such work, tell them it should be filed as an AWB ticket so the normal agent loop handles it (this runtime cannot create tickets itself). Answering questions and light read-only investigation are the only things you do inline.',
    );
  }
  return lines;
}

export function composeChatPrompt(
  _rolePrompt: string,
  history: ChatHistoryEntry[],
  newMessage: string,
  roomId = '',
  usesNativeMcp = true,
): string {
  const lines: string[] = [];
  lines.push('You are an AWB chat subagent responding to a user message in a live conversation.');
  lines.push('');
  if (roomId) {
    lines.push(`Room ID: ${roomId}`);
    lines.push('');
  }
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
  for (const ln of chatReplyInstructions(usesNativeMcp, roomId)) lines.push(ln);
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
  attachments?: PreparedAttachment[],
  usesNativeMcp = true,
  // Prepared attachments for past messages, keyed by the history entry object
  // reference. Slicing/filtering the history array below preserves those
  // references, so a Map keyed by identity stays aligned with the rendered
  // rows. Absent on the legacy oneshot path (text-only history is still
  // correct there — only the inline-vision affordance is missing).
  historyAttachments?: Map<ChatHistoryEntry, PreparedAttachment[]>,
  // Current room title. Empty string → untitled room: we ask the subagent to
  // generate and persist a title on this first turn. Once set, later turns
  // see a non-empty name and the instruction is omitted (one-time naming).
  roomName = '',
  // ticket e6d32e9d: true when this room was minted by an Action dispatch. Flips
  // the work-policy instruction from "this is a chat, file a ticket" to "perform
  // the task directly" and suppresses the auto-title prompt (Action rooms are
  // already named `Action: … · <id>`). Default false → ordinary chat behavior.
  isActionRoom = false,
): string {
  const lines: string[] = [];
  lines.push(
    isActionRoom
      ? 'You are an AWB agent executing an Action Run. The message below is a task assigned to you — perform it directly.'
      : 'You are an AWB chat subagent responding to a user message in a chat room.',
  );
  lines.push('');
  lines.push(`Room ID: ${roomId}`);
  lines.push('');
  const realHistory = Array.isArray(history)
    ? history.filter((h) => !h.type || h.type === 'message')
    : [];
  if (realHistory.length > 0) {
    lines.push('Conversation history (oldest first):');
    for (const h of realHistory.slice(-20)) {
      const who = h.sender_type === 'agent' ? 'Agent' : 'User';
      const name = h.sender_name || h.sender_id || 'unknown';
      const when = h.created_at || '';
      const content = (h.content || '').slice(0, 2000);
      lines.push(`- [${when}] ${who} (${name}): ${content}`);
      const atts = historyAttachments?.get(h);
      if (atts && atts.length > 0) {
        // Indent the per-message attachment block under its history line so
        // the model can tell which past turn each file belongs to.
        for (const ln of renderAttachmentBlock(atts, 'Attachments:')) {
          lines.push(`  ${ln}`);
        }
      }
    }
    lines.push('');
  }
  lines.push('Latest user message:');
  lines.push(newMessage.content || '');
  lines.push(`From: ${newMessage.sender_name || newMessage.sender_id || 'unknown'}`);
  if (Array.isArray(attachments) && attachments.length > 0) {
    lines.push('');
    for (const ln of renderAttachmentBlock(attachments)) {
      lines.push(ln);
    }
  }
  lines.push('');
  lines.push('Instructions:');
  lines.push('- Compose a helpful reply using your knowledge and the conversation context.');
  for (const ln of chatReplyInstructions(usesNativeMcp, roomId, isActionRoom)) lines.push(ln);
  // Auto-title an untitled room (native MCP only — non-native runtimes have no
  // tool to persist the name). Fired only when roomName is empty, which is true
  // just on the opening turn; once set, subsequent turns omit this. Skipped for
  // Action rooms (ticket e6d32e9d): those are already named `Action: … · <id>`,
  // and a task-executing agent shouldn't spend its turn renaming the room.
  if (usesNativeMcp && !isActionRoom && !roomName.trim()) {
    lines.push(
      '- This chat room has no title yet. Derive a concise title (3-6 words) ' +
        'capturing the conversation topic and set it ONCE via the ' +
        `mcp__awb__set_chat_room_name MCP tool (room_id: "${roomId}"), then send your reply. ` +
        'Do not mention the titling in your reply.',
    );
  }
  return lines.join('\n');
}

export const promptComposer: PromptComposer = {
  composeTriggerPrompt,
  composeChatPrompt,
  composeChatRoomPrompt,
  composeCommentMentionPrompt,
};
