import type { DataSource } from 'typeorm';
import { resolveCallerAccountId, resolveCallerIdentityRow } from './authz';
import type { McpAgentContext } from './session-auth';

const ACCOUNT_TOOLS = new Set(['list_tickets', 'get_my_tickets', 'create_ticket', 'list_archived_tickets', 'subscribe_events']);
const DENIED = 'Unauthorized: object not found in the caller account';

/** Ownership is independent of key capability (read/write/full). Apply it to
 * every registration, including legacy tools without a capability gate.
 * Object references are checked against stored ownership before a handler
 * reads content, follows a link, or performs a write.
 */
export async function checkToolOwnership(
  dataSource: DataSource, caller: McpAgentContext | undefined,
  name: string, args: Record<string, any>,
): Promise<string | null> {
  if (name === 'unpend_ticket') return null; // Always rejected as human-only.
  const accountId = await resolveCallerAccountId(dataSource, caller);
  for (const field of ['account_id', 'workspace_id']) {
    if (args[field] && args[field] !== accountId) return DENIED;
  }
  if (ACCOUNT_TOOLS.has(name)) {
    if (!accountId) return DENIED;
    args.account_id = accountId;
  }
  if (['set_current_task', 'clear_current_task'].includes(name)) {
    const agent = await resolveCallerIdentityRow(dataSource, args.agent_id);
    if (!accountId || !agent || agent.account_id !== accountId) return DENIED;
  }
  const tickets = new Set<string>();
  for (const [key, value] of Object.entries(args)) {
    if (/(^|_)ticket_id$/.test(key) && typeof value === 'string' && value) tickets.add(value);
    if (/(^|_)ticket_ids$/.test(key) && Array.isArray(value)) {
      for (const id of value) if (typeof id === 'string' && id) tickets.add(id);
    }
  }
  if (name === 'create_child_ticket' && args.parent_id) tickets.add(args.parent_id);
  if (args.question_comment_id) {
    const comment = await dataSource.getRepository('Comment').findOne({
      where: { id: args.question_comment_id }, select: ['ticket_id'],
    });
    if (!comment?.ticket_id) return DENIED;
    tickets.add(comment.ticket_id);
  }
  if (['get_ticket_attachment', 'delete_ticket_attachment'].includes(name) && args.attachment_id) {
    const attachment = await dataSource.getRepository('TicketAttachment').findOne({
      where: { id: args.attachment_id }, select: ['ticket_id', 'account_id', 'owner_type'],
    });
    if (!attachment?.ticket_id || attachment.owner_type !== 'ticket' || attachment.account_id !== accountId) return DENIED;
    tickets.add(attachment.ticket_id);
  }
  for (const id of tickets) {
    const ticket = await dataSource.getRepository('Ticket').findOne({ where: { id }, select: ['account_id'] });
    if (!accountId || !ticket || ticket.account_id !== accountId) return DENIED;
  }
  // Catalog objects can be explicitly Global. Work and channels cannot.
  const references: Array<[string, string, boolean]> = [
    ['project_id', 'Project', false], ['source_chat_room_id', 'ChatRoom', false],
    ['channel_db_id', 'Channel', false], ['credential_id', 'Credential', true],
    ['resource_id', 'Resource', true], ['artifact_resource_id', 'Resource', true],
  ];
  for (const [field, entity, globalAllowed] of references) {
    if (!args[field]) continue;
    let row = await dataSource.getRepository(entity).findOne({ where: { id: args[field] }, select: ['account_id'] });
    // Repository resources were migrated into Projects with the same UUID.
    if (!row && field === 'resource_id') row = await dataSource.getRepository('Project').findOne({ where: { id: args[field] }, select: ['account_id'] });
    if (!row || !(globalAllowed && row.account_id === null) && (!accountId || row.account_id !== accountId)) return DENIED;
  }
  return null;
}
