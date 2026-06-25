import { ApiTags } from '@nestjs/swagger';
import { Controller, Get, Post, Param, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Resource } from '../../entities/Resource';
import { User } from '../../entities/User';
import { AuthService } from '../../services/auth.service';
import { ReBACService } from '../../services/rebac.service';
import { inferResourceMimetype } from '../mcp/shared/resource-helpers';

/**
 * Binary streaming + raw upload for resource media — the one place the app
 * serves/accepts raw bytes instead of base64-in-JSON.
 *
 * Why a separate controller (not methods on ResourcesController):
 *   1. <img>/<video> tags can only authenticate via a query-string token, not
 *      an Authorization header. ResourcesController is gated by PermissionGuard
 *      (header Bearer only), so these routes need their own header-OR-query auth.
 *   2. Serving bytes via a real URL (with HTTP Range) lets the browser stream
 *      and seek large videos, and — crucially — stops the comment/board JSON
 *      payloads from carrying the full base64 of every attachment on every
 *      refetch (ticket ff3e7337). expandCommentAttachments now ships metadata
 *      only; the client points media tags at this endpoint.
 *   3. ResourcesController is gated by MANAGE_RESOURCES (admin-only). Comment
 *      attachment upload/view must be reachable by any workspace MEMBER, not
 *      just admins — otherwise a non-admin attaching a file gets 403 and the
 *      comment never sends (ticket ff3e7337 review blocker 2). So these routes
 *      authorize by workspace membership (ReBAC member/owner, admin bypass),
 *      mirroring WorkspaceGuard, instead of inheriting the admin permission.
 *
 * Routes:
 *   GET  /api/resources/:id/raw  (two path segments, so it never collides with
 *        ResourcesController's GET /api/resources/:id)
 *   POST /api/resources/upload   (raw body parser mounted in main.ts before
 *        the global json(), so large mp4s bypass the 10MB JSON ceiling)
 */
@ApiTags('resources')
@Controller('api/resources')
export class ResourceMediaController {
  constructor(
    @InjectRepository(Resource) private readonly resourceRepo: Repository<Resource>,
    private readonly authService: AuthService,
    private readonly rebacService: ReBACService,
  ) {}

  // Resolve the session user from an Authorization: Bearer header (fetch
  // callers) OR a ?token= query param (media tags, which cannot set headers).
  private async resolveUser(req: Request, queryToken?: string): Promise<User | null> {
    const authHeader = req.headers['authorization'];
    const headerToken = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : '';
    const token = headerToken || (typeof queryToken === 'string' ? queryToken.trim() : '');
    if (!token) return null;
    return this.authService.getSessionUser(token);
  }

  // Authorize workspace access the same way WorkspaceGuard does: admins bypass,
  // everyone else must hold member OR owner on the workspace. This is the
  // isolation boundary the rest of the app enforces on every ticket/board read.
  private async canAccessWorkspace(user: User, workspaceId: string | null | undefined): Promise<boolean> {
    if (!workspaceId) return false;
    if (user.role === 'admin') return true;
    const isMember = await this.rebacService.check(
      { type: 'user', id: user.id },
      'member',
      { type: 'workspace', id: workspaceId },
    );
    if (isMember) return true;
    return this.rebacService.check(
      { type: 'user', id: user.id },
      'owner',
      { type: 'workspace', id: workspaceId },
    );
  }

  // Raw binary upload — the body is a Buffer (express raw() parser mounted in
  // main.ts for this exact path), NOT JSON. Metadata rides in query params and
  // the X-File-Name header so no base64 inflation and no 10MB JSON ceiling: a
  // large mp4 streams straight in. The bytes are stored base64 in file_data
  // (consistent with the existing Resource model / dual sqlite+pg support),
  // but the client now references the created Resource by id from a comment
  // instead of re-inlining the bytes into the comment POST (ticket ff3e7337).
  //
  // Authorization: any member of the target workspace (admin bypass) — NOT the
  // admin-only MANAGE_RESOURCES of ResourcesController, so non-admin users can
  // attach files to comments.
  @Post('upload')
  async upload(
    @Query('workspace_id') workspaceId: string,
    @Query('board_id') boardId: string | undefined,
    @Query('type') type: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const user = await this.resolveUser(req);
    if (!user) return res.status(401).json({ error: 'Authentication required' });
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id query parameter is required' });
    if (!(await this.canAccessWorkspace(user, workspaceId))) {
      return res.status(403).json({ error: 'workspace_access_denied' });
    }
    const buf: Buffer | null = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buf || buf.length === 0) {
      return res.status(400).json({ error: 'request body is empty — send the file bytes as the raw request body' });
    }
    const rawName = req.headers['x-file-name'];
    let fileName = '';
    if (typeof rawName === 'string' && rawName) {
      try { fileName = decodeURIComponent(rawName); } catch { fileName = rawName; }
    }
    if (!fileName) fileName = 'upload';
    const headerMime = (req.headers['x-file-type'] as string) || req.headers['content-type'] || '';
    const fileData = buf.toString('base64');
    const effectiveMimetype = headerMime && headerMime !== 'application/octet-stream'
      ? headerMime
      : (inferResourceMimetype(fileData, fileName) || headerMime || 'application/octet-stream');
    const resource = await this.resourceRepo.save(
      this.resourceRepo.create({
        workspace_id: workspaceId,
        board_id: boardId || null,
        credential_id: null,
        name: fileName,
        description: '',
        type: type || 'comment_attachment',
        url: '',
        content: '',
        file_data: fileData,
        file_name: fileName,
        file_mimetype: effectiveMimetype,
        tags: '[]',
        default_branch: '',
      }),
    );
    // Return metadata only — never echo file_data back (it would re-inflate the
    // response by ~33% and defeats the point of the streaming /raw endpoint).
    return res.status(201).json({
      id: resource.id,
      workspace_id: resource.workspace_id,
      board_id: resource.board_id,
      name: resource.name,
      type: resource.type,
      file_name: resource.file_name,
      file_mimetype: resource.file_mimetype,
      size: buf.length,
    });
  }

  @Get(':id/raw')
  async raw(
    @Param('id') id: string,
    @Query('token') queryToken: string | undefined,
    @Query('download') download: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    // Auth: Authorization: Bearer <token> (fetch callers) OR ?token=<token>
    // (media tags, which cannot set headers). Same session token either way.
    const authHeader = req.headers['authorization'];
    const hasToken = (typeof authHeader === 'string' && authHeader.startsWith('Bearer ') && authHeader.slice(7).trim())
      || (typeof queryToken === 'string' && queryToken.trim());
    if (!hasToken) return res.status(401).json({ error: 'Authentication required' });
    const user = await this.resolveUser(req, queryToken);
    if (!user) return res.status(401).json({ error: 'Invalid or expired session' });

    const resource = await this.resourceRepo.findOne({ where: { id } });
    if (!resource || !resource.file_data) {
      return res.status(404).json({ error: 'Resource not found or has no file data' });
    }

    // Authorize: only members of the resource's workspace (admin bypass) may
    // stream its bytes. Without this, any authenticated user could read any
    // resource by UUID across workspaces (ticket ff3e7337 review blocker 1) —
    // the one resource-read path that would otherwise ignore the isolation
    // boundary WorkspaceGuard enforces everywhere else.
    if (!(await this.canAccessWorkspace(user, resource.workspace_id))) {
      return res.status(403).json({ error: 'workspace_access_denied' });
    }

    const buf = Buffer.from(resource.file_data, 'base64');
    const total = buf.length;
    const mimetype = resource.file_mimetype || 'application/octet-stream';
    const fileName = resource.file_name || resource.name || 'file';
    // ASCII-safe Content-Disposition (RFC 5987 filename* for unicode names).
    const asciiName = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
    // Stored-XSS hardening (security finding: xss). /raw is same-origin, so an
    // attacker-controlled Content-Type served `inline` (e.g. text/html or
    // image/svg+xml, both reachable via inferResourceMimetype) would execute
    // scripts in the app origin. Only render genuine, non-scriptable media
    // (image except SVG, audio, video) inline; force every other type to
    // download. nosniff additionally stops the browser from MIME-sniffing a
    // mislabeled payload back into an executable type.
    const inlineSafe = /^(image\/(?!svg\b|svg\+xml)|audio\/|video\/)/i.test(mimetype);
    const disposition = download !== undefined || !inlineSafe ? 'attachment' : 'inline';

    res.setHeader('Content-Type', mimetype);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader(
      'Content-Disposition',
      `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    );

    // HTTP Range — lets the browser stream/seek video without pulling the whole
    // file, and is required for <video> scrubbing in Chrome/Safari.
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (match) {
        let start = match[1] ? parseInt(match[1], 10) : 0;
        let end = match[2] ? parseInt(match[2], 10) : total - 1;
        if (Number.isNaN(start)) start = 0;
        if (Number.isNaN(end)) end = total - 1;
        if (start > end || start >= total) {
          res.setHeader('Content-Range', `bytes */${total}`);
          return res.status(416).end();
        }
        if (end >= total) end = total - 1;
        const chunk = buf.subarray(start, end + 1);
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
        res.setHeader('Content-Length', chunk.length);
        return res.end(chunk);
      }
    }

    res.setHeader('Content-Length', total);
    return res.end(buf);
  }
}
