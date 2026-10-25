import { Body, Controller, Get, Header, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { BusinessMailService } from './business-mail.service';
import { BusinessMailWorkflowService } from './business-mail-workflow.service';

@ApiBearerAuth('user-session')
@ApiTags('business')
@Controller('api/business/mail')
@UseGuards(PermissionGuard)
@RequirePermission(PERMISSIONS.MANAGE_BUSINESS)
export class BusinessMailController {
  constructor(private readonly mail: BusinessMailService, private readonly workflow: BusinessMailWorkflowService) {}
  @Get('connections')
  @Header('Cache-Control', 'no-store')
  connections(@Req() req: any) { return this.mail.connections(req.accessibleAccountIds || []); }
  @Post('connections')
  configure(@Req() req: any, @Body() body: any) { return this.mail.configure(req.accessibleAccountIds || [], body); }
  @Post('connections/:id/sync')
  sync(@Req() req: any, @Param('id') id: string) { return this.mail.sync(req.accessibleAccountIds || [], id); }
  @Get('messages')
  @Header('Cache-Control', 'no-store')
  list(@Req() req: any, @Query() query: any) { return this.mail.list(req.accessibleAccountIds || [], query); }
  @Get('messages/:id')
  @Header('Cache-Control', 'no-store')
  detail(@Req() req: any, @Param('id') id: string) { return this.mail.detail(req.accessibleAccountIds || [], id); }
  @Post('messages/:id/confirm')
  confirm(@Req() req: any, @Param('id') id: string, @Body() body: any) { return this.mail.confirm(req.accessibleAccountIds || [], id, body, req.currentUser.id); }
  @Post('connections/:id/send')
  send(@Req() req: any, @Param('id') id: string, @Body() body: any) { return this.mail.send(req.accessibleAccountIds || [], id, body, req.currentUser.id); }
  @Get('messages/:id/reply')
  @Header('Cache-Control', 'no-store')
  reply(@Req() req: any, @Param('id') id: string) { return this.workflow.forMessage(req.accessibleAccountIds || [], id); }
  @Post('messages/:id/reply')
  startReply(@Req() req: any, @Param('id') id: string) { return this.workflow.start(req.accessibleAccountIds || [], id); }
  @Get('replies')
  @Header('Cache-Control', 'no-store')
  replies(@Req() req: any, @Query('status') status?: string) { return this.workflow.list(req.accessibleAccountIds || [], status); }
  @Post('replies/:id/draft')
  editReply(@Req() req: any, @Param('id') id: string, @Body() body: any) { return this.workflow.submit(req.accessibleAccountIds || [], id, body, { userId: req.currentUser.id }); }
  @Post('replies/:id/decision')
  decideReply(@Req() req: any, @Param('id') id: string, @Body() body: any) { return this.workflow.decide(req.accessibleAccountIds || [], id, body, req.currentUser.id); }
}
