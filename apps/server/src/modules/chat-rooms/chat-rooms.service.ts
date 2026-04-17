import { Injectable } from '@nestjs/common';
import { RoomMembershipService } from './room-membership.service';
import { RoomMessagingService } from './room-messaging.service';
import { RoomCrudService } from './room-crud.service';

/**
 * Facade for chat-room operations.
 *
 * The historical 900-line ChatRoomsService has been split into three cohesive services:
 *  - RoomCrudService       — room lifecycle (list / create / detail / rename)
 *  - RoomMembershipService — participant state (add / leave / member-id lookups)
 *  - RoomMessagingService  — message I/O (send / history / read / search / mention dispatch)
 *
 * This class is preserved as a thin pass-through so the existing callers
 * (ChatRoomsController, AgentApiController, plus any future consumers) keep the same
 * injection target and public API. New consumers are free to depend on the narrower
 * service directly instead of the facade.
 */
@Injectable()
export class ChatRoomsService {
  constructor(
    private readonly crud: RoomCrudService,
    private readonly membership: RoomMembershipService,
    private readonly messaging: RoomMessagingService,
  ) {}

  // ───────── Room CRUD ─────────

  async listRooms(workspaceId: string, userId: string): Promise<any[]> {
    return this.crud.listRooms(workspaceId, userId);
  }

  async createRoom(
    workspaceId: string,
    creatorUserId: string,
    participantIds: { participant_type: string; participant_id: string }[],
    name?: string,
  ): Promise<{ room: any; existing: boolean }> {
    return this.crud.createRoom(workspaceId, creatorUserId, participantIds, name);
  }

  async getRoomDetail(roomId: string, userId: string): Promise<any> {
    return this.crud.getRoomDetail(roomId, userId);
  }

  async renameRoom(roomId: string, userId: string, newName: string): Promise<void> {
    return this.crud.renameRoom(roomId, userId, newName);
  }

  // ───────── Membership ─────────

  async addParticipants(
    roomId: string,
    userId: string,
    newParticipants: { participant_type: string; participant_id: string }[],
  ): Promise<void> {
    return this.membership.addParticipants(roomId, userId, newParticipants);
  }

  async leaveRoom(roomId: string, userId: string): Promise<void> {
    return this.membership.leaveRoom(roomId, userId);
  }

  /** Active user-participant IDs for a room. Used by SSE filtering. */
  async getRoomMemberIds(roomId: string): Promise<Set<string>> {
    return this.membership.getRoomMemberIds(roomId);
  }

  /** Active agent-participant IDs for a room. Used by agent proxy SSE. */
  async getRoomAgentMemberIds(roomId: string): Promise<Set<string>> {
    return this.membership.getRoomAgentMemberIds(roomId);
  }

  // ───────── Messaging ─────────

  async getMessages(
    roomId: string,
    userId: string,
    limit: number,
    before?: string,
  ): Promise<any[]> {
    return this.messaging.getMessages(roomId, userId, limit, before);
  }

  async sendMessage(
    roomId: string,
    workspaceId: string,
    senderType: string,
    senderId: string,
    senderName: string,
    content: string,
    images?: Array<{ data: string; filename: string; mimetype: string }>,
  ): Promise<any> {
    return this.messaging.sendMessage(
      roomId,
      workspaceId,
      senderType,
      senderId,
      senderName,
      content,
      images,
    );
  }

  async markRead(roomId: string, userId: string): Promise<void> {
    return this.messaging.markRead(roomId, userId);
  }

  async searchMessages(workspaceId: string, userId: string, query: string, limit = 20): Promise<any[]> {
    return this.messaging.searchMessages(workspaceId, userId, query, limit);
  }
}
