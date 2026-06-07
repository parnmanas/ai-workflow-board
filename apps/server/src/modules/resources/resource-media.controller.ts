import { ApiTags } from '@nestjs/swagger';
import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Resource } from '../../entities/Resource';
import { AuthService } from '../../services/auth.service';

/**
 * Binary streaming for resource media — the one place the app serves raw bytes
 * instead of base64-in-JSON.
 *
 * Why a separate controller (not a method on ResourcesController):
 *   1. <img>/<video> tags can only authenticate via a query-string token, not
 *      an Authorization header. ResourcesController is gated by PermissionGuard
 *      (header Bearer only), so this route needs its own header-OR-query auth.
 *   2. Serving bytes via a real URL (with HTTP Range) lets the browser stream
 *      and seek large videos, and — crucially — stops the comment/board JSON
 *      payloads from carrying the full base64 of every attachment on every
 *      refetch (ticket ff3e7337). expandCommentAttachments now ships metadata
 *      only; the client points media tags at this endpoint.
 *
 * Route: GET /api/resources/:id/raw  (two path segments, so it never collides
 * with ResourcesController's GET /api/resources/:id).
 */
@ApiTags('resources')
@Controller('api/resources')
export class ResourceMediaController {
  constructor(
    @InjectRepository(Resource) private readonly resourceRepo: Repository<Resource>,
    private readonly authService: AuthService,
  ) {}

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
    const headerToken = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : '';
    const token = headerToken || (typeof queryToken === 'string' ? queryToken.trim() : '');
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    const user = await this.authService.getSessionUser(token);
    if (!user) return res.status(401).json({ error: 'Invalid or expired session' });

    const resource = await this.resourceRepo.findOne({ where: { id } });
    if (!resource || !resource.file_data) {
      return res.status(404).json({ error: 'Resource not found or has no file data' });
    }

    const buf = Buffer.from(resource.file_data, 'base64');
    const total = buf.length;
    const mimetype = resource.file_mimetype || 'application/octet-stream';
    const fileName = resource.file_name || resource.name || 'file';
    // ASCII-safe Content-Disposition (RFC 5987 filename* for unicode names).
    const asciiName = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
    const disposition = download !== undefined ? 'attachment' : 'inline';

    res.setHeader('Content-Type', mimetype);
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
