import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AuthGuard } from '../../common/guards/auth.guard';
import { ArtifactRefType } from '../../common/artifact-ref';
import { ArtifactRefsService } from './artifact-refs.service';

@Controller('api/artifact-refs')
@UseGuards(AuthGuard)
export class ArtifactRefsController {
  constructor(private readonly refs: ArtifactRefsService) {}

  @Post('resolve')
  resolve(
    @Body() body: { workspace_id?: string; refs?: Array<{ type: ArtifactRefType; id: string }> },
    @Req() req: Request,
  ) {
    const user = (req as any).currentUser as { id: string; role: string };
    return this.refs.resolveMany(user, body?.workspace_id || '', body?.refs || []);
  }
}
