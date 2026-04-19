import { ApiTags } from '@nestjs/swagger';
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
import { Request, Response } from 'express';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { RoomCrudService } from './room-crud.service';
import { RoomMembershipService } from './room-membership.service';
import { RoomMessagingService } from './room-messaging.service';
import { MAX_IMAGE_SIZE, MAX_IMAGES_PER_MESSAGE, ALLOWED_IMAGE_MIMETYPES } from '../../common/constants/upload';

@ApiTags('chat-rooms')
@Controller('api/chat-rooms')
@UseGuards(AuthGuard, PermissionGuard)
export class ChatRoomsController {
  constructor(
    private readonly crud: RoomCrudService,
    private readonly membership: RoomMembershipService,
    private readonly messaging: RoomMessagingService,
  ) {}

  @Get()
  @RequirePermission(PERMISSIONS.CHAT_VIEW)
  async listRooms(@Req() req: Request, @Res() res: Response) {
    const user = (req as any).currentUser;
    const wsId = req.headers['x-workspace-id'] as string;
    if (!wsId) return res.status(400).json({ error: 'Workspace ID required' });
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
      const result = await this.crud.createRoom(wsId, user.id, participants, name);
      return res.status(201).json(result);
    } catch (err: any) {
      return res.status(err.status || 400).json({ error: err.message });
    }
  }

  // IMPORTANT: This route must be before @Get(':roomId') so Express does not treat
  // the literal string "search" as a roomId value.
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
      const detail = await this.crud.getRoomDetail(roomId, user.id);
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
    try {
      const messages = await this.messaging.getMessages(roomId, user.id, limit, before);
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
    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'content required' });
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
        content,
        images,
      );
      return res.status(201).json(msg);
    } catch (err: any) {
      return res.status(err.status || 400).json({ error: err.message });
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
