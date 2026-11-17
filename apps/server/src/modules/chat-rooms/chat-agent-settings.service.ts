import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { ChatRoom } from '../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../entities/ChatRoomParticipant';
import { RuntimeHost } from '../../entities/RuntimeHost';
import { Credential } from '../../entities/Credential';
import { cliDescriptor } from '../../common/cli-catalog';
import { mergeRuntimeSpec, parseRuntimeSpec, runtimeIdentityKey } from '../../common/runtime-spec';
import { resolveClaudeBackendProfileForDispatch } from '../../common/claude-backend-registry';
import { requiredManagerCapability } from '../../common/manager-capability-gate';
import { activityEvents } from '../../services/activity.service';
import { AgentManagerCommandService } from '../agent-manager/agent-manager-command.service';
import { CommandLedgerService } from '../agent-manager/command-ledger.service';
import { AgentSessionsService } from '../agent-sessions/agent-sessions.service';
import { isSystemManagedRoom, RoomMembershipService } from './room-membership.service';

const CAPABILITY = 'chat_session_restart';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EDITABLE = ['model', 'credential_id', 'cli_runtime_profile', 'runtime_config', 'role_prompt'];
function fail(status: number, message: string): never { throw Object.assign(new Error(message), { status }); }
function revision(row: ChatRoomParticipant): string {
  return createHash('sha256').update(JSON.stringify([row.id, row.participant_id, row.runtime_spec])).digest('hex');
}

/** The room owns these settings; editing a participant never changes a Host or team default. */
@Injectable()
export class ChatAgentSettingsService {
  private readonly pending = new Set<string>();
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly membership: RoomMembershipService,
    private readonly commands: AgentManagerCommandService,
    private readonly ledger: CommandLedgerService,
    private readonly sessions: AgentSessionsService,
  ) {}

  private async target(em: EntityManager, roomId: string, accountId: string, userId: string, rowId: string) {
    if (!UUID_RE.test(roomId) || !UUID_RE.test(rowId)) fail(400, 'Invalid room or participant ID');
    const room = await em.findOneBy(ChatRoom, { id: roomId, account_id: accountId });
    if (!room) fail(404, 'Room not found');
    const caller = await em.findOneBy(ChatRoomParticipant, { room_id: roomId, participant_type: 'user', participant_id: userId, left_at: IsNull() });
    if (!caller) fail(403, 'Not an active participant in this room');
    if (isSystemManagedRoom(room)) fail(409, 'This agent is configured by its mission or run. Change its settings there.');
    const row = await em.findOneBy(ChatRoomParticipant, { id: rowId, room_id: roomId, participant_type: 'agent', left_at: IsNull() });
    const runtime = parseRuntimeSpec(row?.runtime_spec);
    if (!row || !runtime) fail(404, 'This participant has no editable runtime settings');
    return { room, row, runtime };
  }

  async get(roomId: string, accountId: string, userId: string, rowId: string) {
    const { row, runtime } = await this.target(this.db.manager, roomId, accountId, userId, rowId);
    const host = UUID_RE.test(runtime.manager_agent_id)
      ? await this.db.getRepository(RuntimeHost).findOneBy({ id: runtime.manager_agent_id, account_id: accountId, is_active: 1 }) : null;
    const instance = host ? this.commands.resolveLiveManagerInstance(host.id) : null;
    const available = !!instance && instance.account_id === accountId && !!instance.manager_capabilities?.includes(CAPABILITY);
    return { participant_row_id: row.id, participant_id: row.participant_id, runtime, revision: revision(row),
      // Reuse the public projection after room authorization; chat users need no native-session permission.
      connection_settings: host ? await this.sessions.getCliSettings(accountId, host.id, runtime.cli) : null,
      approve_available: instance?.runtime_capabilities?.[runtime.cli]?.capabilities.native_approvals !== false,
      host_name: host?.name || runtime.manager_agent_id, can_restart: available,
      unavailable_reason: !instance ? 'Runtime Host is offline' : !available ? 'Update Agent Manager to change chat agent settings' : null };
  }

  async restart(roomId: string, accountId: string, userId: string, rowId: string, input: unknown) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'Settings object required');
    const body = input as Record<string, unknown>;
    // AuthGuard normalizes the owning account onto the request body.
    if (Object.keys(body).some(key => !['expected_revision', 'settings', 'account_id'].includes(key))) fail(400, 'Unknown settings field');
    const patch = body.settings ?? {};
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !EDITABLE.includes(key))) fail(400, 'Unknown settings field');
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'runtime_config') continue;
      if (value !== null && (typeof value !== 'string' || value.length > (key === 'role_prompt' ? 16000 : 256))) fail(400, `Invalid ${key}`);
    }
    const lockKey = `${roomId}:${rowId}`;
    if (this.pending.has(lockKey)) fail(409, 'This agent is already restarting');
    this.pending.add(lockKey);
    try {
      const original = await this.target(this.db.manager, roomId, accountId, userId, rowId);
      if (body.expected_revision !== revision(original.row)) fail(409, 'The agent settings changed. Reload and try again.');
      const runtime = mergeRuntimeSpec(original.runtime, patch, 'settings');
      if (runtime.cli === 'hermes' && (runtime.runtime_config.profile || '') !== (original.runtime.runtime_config.profile || '')) {
        fail(400, 'Hermes profiles are shared across rooms and cannot be changed here.');
      }
      const host = UUID_RE.test(runtime.manager_agent_id)
        ? await this.db.getRepository(RuntimeHost).findOneBy({ id: runtime.manager_agent_id, account_id: accountId, is_active: 1 }) : null;
      if (!host) fail(403, 'Runtime Host is not available to this account');
      const instance = this.commands.resolveLiveManagerInstance(host.id);
      if (!instance || instance.account_id !== accountId) fail(409, 'Runtime Host is offline');
      if (!instance.manager_capabilities?.includes(CAPABILITY)) fail(409, 'Update Agent Manager to change chat agent settings');
      const descriptor = cliDescriptor(runtime.cli);
      if (runtime.runtime_config.permission_mode === 'approve' && instance.runtime_capabilities?.[runtime.cli]?.capabilities.native_approvals === false) {
        fail(400, 'This CLI cannot request approval in chat. Choose strict or trusted permissions.');
      }
      if (runtime.credential_id) {
        if (!UUID_RE.test(runtime.credential_id)) fail(400, 'Invalid credential ID');
        const credential = await this.db.getRepository(Credential).findOneBy({ id: runtime.credential_id });
        if (!credential || (credential.account_id !== null && credential.account_id !== accountId)) fail(404, 'Credential is not available to this account');
        if (!descriptor?.credential || !credential.provider.startsWith(descriptor.credential.prefix)) fail(400, 'Credential does not match this CLI');
      }
      if (runtime.cli_runtime_profile && !descriptor?.sessions.backend_profile) fail(400, 'This CLI does not support a backend profile');
      const profile = runtime.cli_runtime_profile
        ? await resolveClaudeBackendProfileForDispatch(this.db, [{ source: 'agent', value: runtime.cli_runtime_profile }]) : null;
      if (profile?.credential_ref && profile.credential_ref !== runtime.credential_id) fail(409, 'Select the credential required by this backend');
      const capability = requiredManagerCapability(profile);
      if (capability && !instance.manager_capabilities?.includes(capability)) fail(409, 'Update Agent Manager to use this backend');
      const newId = runtimeIdentityKey(runtime);
      // All validation precedes the write. No host/network operation runs inside this transaction.
      await this.db.transaction(async em => {
        if (this.db.options.type === 'postgres') await em.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`chat_room_participants:${roomId}`]);
        const current = await this.target(em, roomId, accountId, userId, rowId);
        if (body.expected_revision !== revision(current.row)) fail(409, 'The agent settings changed. Reload and try again.');
        if (newId !== current.row.participant_id) {
          const duplicate = await em.findOneBy(ChatRoomParticipant, { room_id: roomId, participant_type: 'agent', participant_id: newId, left_at: IsNull() });
          if (duplicate) fail(409, 'An agent with this credential and working folder is already in the room');
          // Retain the old address/spec for historical messages; the selected row stays stable for the editor.
          await em.insert(ChatRoomParticipant, { ...current.row, id: randomUUID(), left_at: new Date() });
        }
        current.row.participant_id = newId;
        current.row.runtime_spec = { ...runtime };
        await em.save(ChatRoomParticipant, current.row);
      });
      activityEvents.emit('chat_room_update', { room_id: roomId, update_type: 'participant_updated', participant_type: 'agent', participant_id: newId,
        member_ids: await this.membership.getRoomMemberIds(roomId), agent_member_ids: await this.membership.getRoomAgentMemberIds(roomId) });
      const { command_id } = await this.commands.issue(instance, 'restart_chat_session', {
        room_id: roomId, agent_id: newId, previous_agent_id: original.row.participant_id,
        account_id: accountId, runtime, cli_runtime_profile: profile, room_name: original.room.name || '',
      }, userId);
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const outcome = this.ledger.getOutcome(command_id);
        if (outcome) {
          if (outcome.status !== 'ok') fail(502, `Settings saved, but restarting failed: ${outcome.detail}. Retry Restart process.`);
          let application = 'restarted';
          try {
            const reported = JSON.parse(outcome.detail).application;
            if (reported === 'next_message' || reported === 'session_reopened') application = reported;
          } catch { /* Older compatible acknowledgements have no structured detail. */ }
          return { ...(await this.get(roomId, accountId, userId, rowId)), application };
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      fail(504, 'Settings saved, but the host has not confirmed the restart. Reload before retrying.');
    } finally { this.pending.delete(lockKey); }
  }
}
