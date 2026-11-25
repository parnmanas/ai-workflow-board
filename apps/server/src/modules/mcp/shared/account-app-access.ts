import { DataSource, In } from 'typeorm';
import { Account } from '../../../entities/Account';
import { User } from '../../../entities/User';
import { hasPermission, PERMISSIONS as P, type Permission } from '../../../common/types/permissions';
import type { McpAgentContext } from './session-auth';

/** A grant delegates its owner's current permissions for exactly one account. */
export async function accountAppOwner(ds: DataSource, caller: McpAgentContext) {
  if (caller.source !== 'oauth' || caller.scope !== 'full' || !caller.userId || !caller.accountId) return null;
  return ds.getRepository(User).createQueryBuilder('u')
    .innerJoin(Account, 'a', 'a.owner_user_id = CAST(u.id AS varchar)')
    .where('a.id = :account AND u.id = :user AND u.status = :status', { account: caller.accountId, user: caller.userId, status: 'active' })
    .getOne();
}

const domainPermissions: Record<string, Permission> = {
  action: P.MANAGE_ACTIONS, 'automation-schedule': P.MANAGE_ACTIONS, build: P.MANAGE_ACTIONS,
  deployment: P.MANAGE_ACTIONS, orchestration: P.MANAGE_ACTIONS, qa: P.MANAGE_ACTIONS,
  'qa-schedule': P.MANAGE_ACTIONS, security: P.MANAGE_ACTIONS, 'security-schedule': P.MANAGE_ACTIONS,
  'workflow-function': P.MANAGE_FUNCTIONS, github: P.MANAGE_RESOURCES, ontology: P.MANAGE_RESOURCES,
  resource: P.MANAGE_RESOURCES, credential: P.MANAGE_CREDENTIALS, 'api-key': P.MANAGE_API_KEYS,
  'claude-backend-profile': P.MANAGE_AGENTS, 'agent-status': P.MANAGE_AGENTS, misc: P.MANAGE_CHANNELS,
  marketing: P.MANAGE_MARKETING, outreach: P.MANAGE_MARKETING, activity: P.VIEW_ACTIVITY,
  'session-message': P.USE_AGENT_SESSIONS, operator: P.USE_AGENT_SESSIONS, 'event-subscription': P.USE_AGENT_SESSIONS,
  'privileged-command': P.ADMIN_ACCESS, 'skill-proposal': P.MANAGE_RESOURCES, 'ci-wait': P.EDIT_TICKETS,
  trigger: P.VIEW_ACTIVITY, user: P.MANAGE_USERS,
};

function permissionFor(domain: string, name: string): Permission | null | undefined {
  if (name === 'whoami' || domain === 'knowledge') return null;
  if (domain === 'project') return name === 'save_project' ? P.MANAGE_RESOURCES : null;
  if (domain === 'chat') return /^(get|list|search)_/.test(name) ? P.CHAT_VIEW : P.CHAT_SEND;
  if (domain === 'business' || domain.startsWith('business-')) return P.MANAGE_BUSINESS;
  if (domain === 'comment' || domain === 'archive' || domain.startsWith('ticket-')) {
    if (/^(list|get)_/.test(name)) return null;
    if (name.startsWith('delete_')) return P.DELETE_TICKETS;
    if (name.startsWith('create_')) return P.CREATE_TICKETS;
    return P.EDIT_TICKETS;
  }
  return domainPermissions[domain];
}

export async function checkAccountAppTool(
  ds: DataSource, caller: McpAgentContext, domain: string, name: string,
  args: Record<string, any>, acceptsAccountId: boolean,
) {
  const user = await accountAppOwner(ds, caller);
  if (!user) return 'Unauthorized: the app requires current account access.';
  if (acceptsAccountId) {
    if (args.account_id !== undefined && args.account_id !== caller.accountId) {
      return 'Unauthorized: the requested account differs from the selected account.';
    }
    args.account_id = caller.accountId;
  }
  const required = permissionFor(domain, name);
  const permissions = JSON.parse(user.permissions || '[]');
  if (required === undefined || (required && !hasPermission(user.role, permissions, required))) {
    return 'Unauthorized: this account connection lacks permission for this operation' + (required ? ` (${required}).` : '.');
  }
  // Independent keys survive OAuth disconnect and need their own explicit consent.
  if (domain === 'api-key' && !caller.canManageKeys && !['list_api_keys', 'get_api_key'].includes(name)) {
    return 'Reconnect and allow API key management (awb.keys) to change independent API keys.';
  }
  // Status beacons and approvals are meaningful only from the assigned runtime.
  if (domain === 'agent-status' || name === 'set_typing' || name === 'complete_action_run') return 'Use the assigned native agent session for this operation.';
  if (domain === 'comment') {
    args.author_type = 'user'; args.author_id = user.id; args.author = `${user.name} (${caller.agentName})`;
    delete args.author_role;
    if (args.metadata) delete args.metadata.author_role;
  }
  if (name === 'add_ticket_attachment') {
    args.uploaded_by_type = 'user'; args.uploaded_by_id = user.id; args.uploaded_by = user.name;
  }
  // Several legacy tools accept an object ID without an account argument. Check the
  // stored owner before following it, including the IDs in batch and schedule requests.
  const refs: [string, unknown][] = [];
  if (domain === 'chat') refs.push(['ChatRoom', args.room_id]);
  if (domain === 'action') refs.push(['Action', args.action_id ?? args.id], ['ActionRun', args.run_id]);
  if (domain === 'qa' || domain === 'qa-schedule') refs.push(['QaScenario', args.scenario_id ?? args.scenario_ids]);
  if (domain === 'security' || domain === 'security-schedule') refs.push(['SecurityProfile', args.profile_id ?? args.profile_ids]);
  if (domain === 'build') refs.push(['QaRun', args.run_id]);
  for (const [entity, value] of refs) {
    if (value == null) continue;
    const ids = [...new Set(Array.isArray(value) ? value : [value])];
    if (ids.length && await ds.getRepository(entity).countBy({ id: In(ids), account_id: caller.accountId }) !== ids.length) {
      return 'Unauthorized: object not found in the selected account.';
    }
  }
  return null;
}
