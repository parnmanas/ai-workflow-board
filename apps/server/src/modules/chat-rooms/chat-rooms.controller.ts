import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Request, Response } from 'express';
import { Repository } from 'typeorm';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { RoomCrudService } from './room-crud.service';
import { RoomMembershipService } from './room-membership.service';
import { RoomMessagingService } from './room-messaging.service';
import { TicketAttachment } from '../../entities/TicketAttachment';
import { MAX_IMAGE_SIZE, MAX_IMAGES_PER_MESSAGE, ALLOWED_IMAGE_MIMETYPES, MAX_TICKET_ATTACHMENT_SIZE } from '../../common/constants/upload';
import { approxBase64Size, projectChatAttachment, validateAttachmentMimetype } from '../mcp/shared/ticket-helpers';

@ApiBearerAuth('user-session')
@ApiTags('chat-rooms')
@Controller('api/chat-rooms')
@UseGuards(AuthGuard, PermissionGuard)
export class ChatRoomsController {
  constructor(
    private readonly crud: RoomCrudService,
    private readonly membership: RoomMembershipService,
    private readonly messaging: RoomMessagingService,
    @InjectRepository(TicketAttachment)
    private readonly attachmentRepo: Repository<TicketAttachment>,
  ) {}

  @Get()
  @RequirePermission(PERMISSIONS.CHAT_VIEW)
  async listRooms(@Req() req: Request, @Res() res: Response, @Query('scope') scope?: string) {
    const wsId = req.headers['x-workspace-id'] as string;
    if (!wsId) return res.status(400).json({ error: 'Workspace ID required' });
    if (scope === 'workspace') {
      // Observer view: every active room in this workspace, including ones
      // the caller is not a participant in (e.g., agent-to-agent DMs).
      const rooms = await this.crud.listAllWorkspaceRooms(wsId);
      return res.json(rooms);
    }
    const user = (req as any).currentUser;
    const rooms = await this.crud.listRooms(wsId, user.id);
    return res.json(rooms);
  }

  @Post()
  @RequirePermission(PERMISSIONS.CHAT_SEND)
  async createRoom(@Req() req: Request, @Res() res: Response, @Body() body: any) {
    const user = (req as any).currentUser;
    const wsId = req.headers['x-workspace-id'] as string;
    if (!wsId) return res.status(400).json({ error: 'Workspace ID required' });
    const { participants, name } = body;
    if (!participants || !Array.isArray(participants)) {
      return res.status(400).json({ error: 'participants array required' });
    }
    try {
      const result = await this.crud.createRoom(wsId, { type: 'user', id: user.id }, participants, name);
      return res.status(201).json(result);
    } catch (err: any) {
      return res.status(err.status || 400).json({ error: err.message });
    }
  }

  // IMPORTANT: This route must be before @Get(':roomId') so Express does not treat
  // the literal string "unread-counts" / "search" as a roomId value.
  @Get('unread-counts')
  @RequirePermission(PERMISSIONS.CHAT_VIEW)
  async unreadCounts(@Req() req: Request, @Res() res: Response) {
    const user = (req as any).currentUser;
    const wsId = req.headers['x-workspace-id'] as string;
    if (!wsId) return res.status(400).json({ error: 'Workspace ID required' });
    // Reuse listRooms — it already computes per-room unread counts via the
    // same datetime-comparison query the chat page uses. Sidebar badge
    // doesn't need room metadata (name, last message, dm partner), so we
    // project just { total, perRoom } here. Sum is trivial client-side too
    // but returning it explicitly avoids a client-side reduce loop.
    const rooms = await this.crud.listRooms(wsId, user.id);
    const perRoom: Record<string, number> = {};
    let total = 0;
    for (const r of rooms) {
      const n = Number(r.unread_count || 0);
      if (n > 0) perRoom[r.id] = n;
      total += n;
    }
    return res.json({ total, perRoom });
  }

  @Get('search')
  @RequirePermission(PERMISSIONS.CHAT_VIEW)
  async searchMessages(
    @Query('q') q: string,
    @Query('workspace_id') wsId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!q || q.length < 2) {
      return res.status(400).json({ error: 'Query must be at least 2 characters' });
    }
    if (!wsId) {
      return res.status(400).json({ error: 'workspace_id is required' });
    }
    try {
      const user = (req as any).currentUser;
      const results = await this.messaging.searchMessages(wsId, user.id, q);
      return res.json(results);
    } catch (err: any) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  }

  @Get(':roomId')
  @RequirePermission(PERMISSIONS.CHAT_VIEW)
  async getRoom(@Req() req: Request, @Res() res: Response, @Param('roomId') roomId: string) {
    const user = (req as any).currentUser;
    try {
      // getRoomDetail already tolerates a non-member viewer (it just won't
      // compute unread/last-read for them). Pass empty string when the
      // caller is an observer — same treatment as agent callers in
      // create_chat_room.
      const observe = req.query.observer === 'true';
      const detail = await this.crud.getRoomDetail(roomId, observe ? '' : user.id);
      return res.json(detail);
    } catch (err: any) {
      return res.status(err.status || 404).json({ error: err.message });
    }
  }

  @Get(':roomId/messages')
  @RequirePermission(PERMISSIONS.CHAT_VIEW)
  async getMessages(@Req() req: Request, @Res() res: Response, @Param('roomId') roomId: string) {
    const user = (req as any).currentUser;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const before = req.query.before as string | undefined;
    const observer = req.query.observer === 'true';
    try {
      const messages = await this.messaging.getMessages(roomId, user.id, limit, before, { observer });
      return res.json(messages);
    } catch (err: any) {
      return res.status(err.status || 403).json({ error: err.message });
    }
  }

  @Post(':roomId/messages')
  @RequirePermission(PERMISSIONS.CHAT_SEND)
  async sendMessage(@Req() req: Request, @Res() res: Response, @Param('roomId') roomId: string, @Body() body: any) {
    const user = (req as any).currentUser;
    const wsId = req.headers['x-workspace-id'] as string;
    const { content } = body;
    const attachmentIds = Array.isArray(body.attachment_ids) ? body.attachment_ids : [];
    // Attachment-only messages (screenshot / file share without a caption) are
    // a supported workflow — defer the empty-payload check to the service so
    // it can apply the "content OR attachment_ids" rule consistently across
    // REST / agent-api / MCP entry points.
    if (content != null && typeof content !== 'string') {
      return res.status(400).json({ error: 'content must be a string' });
    }
    if ((!content || !content.trim()) && attachmentIds.length === 0) {
      return res.status(400).json({ error: 'content or attachment_ids required' });
    }

    // Image validation (T-08-02-02, T-08-02-03)
    const images = Array.isArray(body.images) ? body.images : [];
    if (images.length > MAX_IMAGES_PER_MESSAGE) {
      return res.status(400).json({ error: 'Maximum 5 images per message' });
    }
    for (const img of images) {
      if (!img.mimetype || !ALLOWED_IMAGE_MIMETYPES.has(img.mimetype)) {
        return res.status(400).json({ error: 'Unsupported image format. Use JPEG, PNG, GIF, or WebP.' });
      }
      if (!img.data || typeof img.data !== 'string') {
        return res.status(400).json({ error: 'Image data is required' });
      }
      // base64 decoded size check: each base64 char encodes 6 bits, 4 chars = 3 bytes
      const approxBytes = (img.data.length * 3) / 4;
      if (approxBytes > MAX_IMAGE_SIZE) {
        return res.status(400).json({ error: 'Image too large (max 5 MB per image)' });
      }
    }

    try {
      const msg = await this.messaging.sendMessage(
        roomId,
        wsId,
        'user',
        user.id,
        user.name || user.email,
        content ?? '',
        images,
        attachmentIds,
      );
      return res.status(201).json(msg);
    } catch (err: any) {
      return res.status(err.status || 400).json({ error: err.message });
    }
  }

  @Post(':roomId/attachments')
  @RequirePermission(PERMISSIONS.CHAT_SEND)
  async addAttachment(@Req() req: Request, @Res() res: Response, @Param('roomId') roomId: string, @Body() body: any) {
    const user = (req as any).currentUser;
    const wsId = req.headers['x-workspace-id'] as string;
    if (!wsId) return res.status(400).json({ error: 'Workspace ID required' });

    const incoming: any[] = Array.isArray(body?.attachments)
      ? body.attachments
      : (body?.file_data ? [body] : []);
    if (incoming.length === 0) {
      return res.status(400).json({ error: 'attachments[] (or a single file_data + file_name) is required' });
    }
    for (const f of incoming) {
      if (!f || typeof f !== 'object' || !f.file_data || !f.file_name) {
        return res.status(400).json({ error: 'Each attachment must include file_data and file_name' });
      }
      if (approxBase64Size(f.file_data) > MAX_TICKET_ATTACHMENT_SIZE) {
        return res.status(400).json({ error: `Attachment ${f.file_name} exceeds ${MAX_TICKET_ATTACHMENT_SIZE / 1024 / 1024}MB limit` });
      }
    }

    try {
      await this.membership.requireActiveParticipant(roomId, user.id, 'user');
      const saved: TicketAttachment[] = [];
      for (const f of incoming) {
        // Sniff the file bytes BEFORE persistence so a forged mime can
        // never reach disk. validateAttachmentMimetype throws status=400
        // on a definitive mismatch (e.g. caller claims image/png but the
        // bytes are PDF) — caught below and surfaced as 400.
        const verifiedMime = validateAttachmentMimetype(f.file_name, f.file_mimetype, f.file_data);
        // Pre-send owner_type='chat_room' (planner-fixed contract). On send,
        // _validatePendingAttachments transitions to owner_type='chat_message'
        // and owner_id=message_id. Room-scoped pre-send rows can be GC'd via
        // the same room_id index without joining against chat_room_messages.
        const row = await this.attachmentRepo.save(this.attachmentRepo.create({
          owner_type: 'chat_room',
          owner_id: roomId,
          ticket_id: null,
          room_id: roomId,
          workspace_id: wsId,
          file_name: f.file_name,
          file_mimetype: verifiedMime,
          file_data: f.file_data,
          file_size: approxBase64Size(f.file_data),
          uploaded_by_type: 'user',
          uploaded_by_id: user.id,
          uploaded_by: user.name || user.email || '',
        }));
        saved.push(row);
      }
      const out = saved.map(r => projectChatAttachment(r, { includeData: false }));
      return res.status(201).json(Array.isArray(body?.attachments) ? out : out[0]);
    } catch (err: any) {
      return res.status(err.status || 400).json({ error: err.message });
    }
  }

  @Get(':roomId/attachments/:attachmentId')
  @RequirePermission(PERMISSIONS.CHAT_VIEW)
  async getAttachment(
    @Req() req: Request,
    @Res() res: Response,
    @Param('roomId') roomId: string,
    @Param('attachmentId') attachmentId: string,
  ) {
    const user = (req as any).currentUser;
    try {
      await this.membership.requireActiveParticipant(roomId, user.id, 'user');
      // Accept both pre-send (owner_type='chat_room') and post-send
      // (owner_type='chat_message') rows: the room_id anchor enforces
      // workspace + room scope either way, so the uploader can preview
      // before send and any room participant can download after send.
      const row = await this.attachmentRepo.findOne({
        where: { id: attachmentId, room_id: roomId },
      });
      if (!row || (row.owner_type !== 'chat_room' && row.owner_type !== 'chat_message')) {
        return res.status(404).json({ error: 'Attachment not found' });
      }
      return res.json(projectChatAttachment(row, { includeData: true }));
    } catch (err: any) {
      return res.status(err.status || 403).json({ error: err.message });
    }
  }

  // Discard a pending upload — only valid while owner_type='chat_room'. Once
  // the message has been sent (owner_type transitions to 'chat_message'),
  // the attachment lives and dies with the message; per-attachment delete is
  // no longer accepted. Restricted to the original uploader so a co-participant
  // can't strip a file from another sender's pending draft.
  @Delete(':roomId/attachments/:attachmentId')
  @RequirePermission(PERMISSIONS.CHAT_SEND)
  async deletePendingAttachment(
    @Req() req: Request,
    @Res() res: Response,
    @Param('roomId') roomId: string,
    @Param('attachmentId') attachmentId: string,
  ) {
    const user = (req as any).currentUser;
    try {
      await this.membership.requireActiveParticipant(roomId, user.id, 'user');
      const row = await this.attachmentRepo.findOne({
        where: { id: attachmentId, room_id: roomId },
      });
      if (!row || (row.owner_type !== 'chat_room' && row.owner_type !== 'chat_message')) {
        return res.status(404).json({ error: 'Attachment not found' });
      }
      if (row.owner_type === 'chat_message') {
        return res.status(409).json({ error: 'Attachment is already sent and cannot be deleted directly' });
      }
      if (row.uploaded_by_type !== 'user' || row.uploaded_by_id !== user.id) {
        return res.status(403).json({ error: 'Only the uploader can discard a pending attachment' });
      }
      await this.attachmentRepo.delete({ id: attachmentId });
      return res.json({ ok: true });
    } catch (err: any) {
      return res.status(err.status || 403).json({ error: err.message });
    }
  }

  @Patch(':roomId/read')
  @RequirePermission(PERMISSIONS.CHAT_VIEW)
  async markRead(@Req() req: Request, @Res() res: Response, @Param('roomId') roomId: string) {
    const user = (req as any).currentUser;
    try {
      await this.messaging.markRead(roomId, user.id);
      return res.json({ ok: true });
    } catch (err: any) {
      return res.status(err.status || 403).json({ error: err.message });
    }
  }

  @Patch(':roomId/name')
  @RequirePermission(PERMISSIONS.CHAT_SEND)
  async renameRoom(@Req() req: Request, @Res() res: Response, @Param('roomId') roomId: string, @Body() body: any) {
    const user = (req as any).currentUser;
    const { name } = body;
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'name required' });
    }
    try {
      await this.crud.renameRoom(roomId, user.id, name);
      return res.json({ ok: true });
    } catch (err: any) {
      return res.status(err.status || 400).json({ error: err.message });
    }
  }

  @Post(':roomId/participants')
  @RequirePermission(PERMISSIONS.CHAT_SEND)
  async addParticipants(@Req() req: Request, @Res() res: Response, @Param('roomId') roomId: string, @Body() body: any) {
    const user = (req as any).currentUser;
    const { participants } = body;
    if (!participants || !Array.isArray(participants)) {
      return res.status(400).json({ error: 'participants array required' });
    }
    try {
      await this.membership.addParticipants(roomId, user.id, participants);
      return res.json({ ok: true });
    } catch (err: any) {
      return res.status(err.status || 400).json({ error: err.message });
    }
  }

  @Delete(':roomId/participants/me')
  @RequirePermission(PERMISSIONS.CHAT_VIEW)
  async leaveRoom(@Req() req: Request, @Res() res: Response, @Param('roomId') roomId: string) {
    const user = (req as any).currentUser;
    try {
      await this.membership.leaveRoom(roomId, user.id);
      return res.json({ ok: true });
    } catch (err: any) {
      return res.status(err.status || 400).json({ error: err.message });
    }
  }
}
