import { Body, Controller, Delete, ForbiddenException, Get, Header, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { hasPermission, PERMISSIONS } from '../../common/types/permissions';
import { BusinessFormationService } from './business-formation.service';
import { BusinessService } from './business.service';
import { BUSINESS_CONNECTORS } from './connectors/registry';

@ApiBearerAuth('user-session')
@ApiTags('business')
@Controller('api/business')
@UseGuards(PermissionGuard)
@RequirePermission(PERMISSIONS.MANAGE_BUSINESS)
export class BusinessController {
  constructor(private readonly business: BusinessService, private readonly formation: BusinessFormationService) {}
  private marketing(req: any) {
    return [PERMISSIONS.MANAGE_MARKETING, PERMISSIONS.APPROVE_MARKETING_SPEND].some(p => hasPermission(req.currentUser.role, req.currentUser.permissions, p));
  }

  @Get('connectors') catalog() { return BUSINESS_CONNECTORS.map(c => c.descriptor); }
  @Get('credentials') credentials(@Req() req: any) { return this.business.credentials(req.currentAccountId); }
  @Get('companies') list(@Req() req: any) { return this.business.list(req.accessibleAccountIds || []); }
  @Post('companies') create(@Req() req: any, @Body() body: any) {
    return this.business.create(req.currentAccountId, body, req.currentUser.id, this.marketing(req));
  }
  @Get('companies/:id') detail(@Param('id') id: string, @Req() req: any) {
    return this.business.detail(id, req.currentAccountId, this.marketing(req));
  }
  @Patch('companies/:id') update(@Param('id') id: string, @Req() req: any, @Body() body: any) {
    return this.business.update(id, req.currentAccountId, body, req.currentUser.id, this.marketing(req));
  }
  @Post('companies/:id/services/:stage') chooseService(@Param('id') id: string, @Param('stage') stage: string, @Req() req: any, @Body() body: any) {
    return this.business.chooseService(id, req.currentAccountId, stage, body, req.currentUser.id);
  }
  @Post('companies/:id/self-service/assess') assessSelfService(@Param('id') id: string, @Req() req: any, @Body() body: any) {
    return this.business.assessSelfService(id, req.currentAccountId, body?.provider, body?.plan, body?.answers);
  }
  @Post('companies/:id/tasks') addTask(@Param('id') id: string, @Req() req: any, @Body() body: any) {
    return this.business.saveTask(id, req.currentAccountId, null, body, req.currentUser.id);
  }
  @Post('companies/:id/stages/trademark') initializeTrademark(@Param('id') id: string, @Req() req: any, @Body() body: any) {
    return this.business.initializeTrademark(id, req.currentAccountId, body?.revision, req.currentUser.id);
  }
  @Patch('companies/:id/tasks/:taskId') task(@Param('id') id: string, @Param('taskId') taskId: string, @Req() req: any, @Body() body: any) {
    return this.business.saveTask(id, req.currentAccountId, taskId, body, req.currentUser.id);
  }
  @Header('Cache-Control', 'no-store')
  @Get('companies/:id/tasks/:taskId') taskDetail(@Param('id') id: string, @Param('taskId') taskId: string, @Req() req: any, @Query('before') before?: string) {
    return this.business.taskDetail(id, req.currentAccountId, taskId, before === undefined ? undefined : Number(before));
  }
  @Post('companies/:id/tasks/:taskId/entries') addTaskEntry(@Param('id') id: string, @Param('taskId') taskId: string, @Req() req: any, @Body() body: any) {
    return this.business.addTaskEntry(id, req.currentAccountId, taskId, body, { id: req.currentUser.id, name: req.currentUser.name, type: 'user' });
  }
  @Delete('companies/:id/tasks/:taskId') removeTask(@Param('id') id: string, @Param('taskId') taskId: string, @Req() req: any, @Body() body: any) {
    return this.business.removeTask(id, req.currentAccountId, taskId, body?.revision, req.currentUser.id);
  }
  @Post('companies/:id/tasks/:taskId/ticket') createTaskTicket(@Param('id') id: string, @Param('taskId') taskId: string, @Req() req: any, @Body() body: any) {
    // Keep the class-level business permission and require ticket creation as well.
    if (!hasPermission(req.currentUser.role, req.currentUser.permissions, PERMISSIONS.CREATE_TICKETS)) throw new ForbiddenException('티켓 생성 권한이 필요합니다.');
    return this.business.createTaskTicket(id, req.currentAccountId, taskId, body?.revision, { id: req.currentUser.id, name: req.currentUser.name, type: 'user' });
  }
  @Post('companies/:id/formation/:provider/references') formationReferences(@Param('id') id: string, @Param('provider') provider: string, @Req() req: any, @Body() body: any) {
    return this.formation.references(id, req.currentAccountId, provider, body);
  }
  @Post('companies/:id/formation/:provider/prepare') prepareFormation(@Param('id') id: string, @Param('provider') provider: string, @Req() req: any, @Body() body: any) {
    return this.formation.prepare(id, req.currentAccountId, provider, body, req.currentUser.id);
  }
  @Header('Cache-Control', 'no-store')
  @Get('companies/:id/formations/:actionId/review') reviewFormation(@Param('id') id: string, @Param('actionId') actionId: string, @Req() req: any) {
    return this.formation.review(id, req.currentAccountId, actionId);
  }
  @Post('companies/:id/formations/:actionId/submit') submitFormation(@Param('id') id: string, @Param('actionId') actionId: string, @Req() req: any, @Body() body: any) {
    return this.formation.submit(id, req.currentAccountId, actionId, body, req.currentUser.id);
  }
  @Delete('companies/:id/formations/:actionId') discardFormation(@Param('id') id: string, @Param('actionId') actionId: string, @Req() req: any, @Body() body: any) {
    return this.formation.discard(id, req.currentAccountId, actionId, body, req.currentUser.id);
  }
  @Header('Cache-Control', 'no-store')
  @Post('companies/:id/formations/:actionId/signature') formationSignature(@Param('id') id: string, @Param('actionId') actionId: string, @Req() req: any, @Body() body: any) {
    return this.formation.signature(id, req.currentAccountId, actionId, body);
  }
  @Post('companies/:id/connections/:provider') connect(@Param('id') id: string, @Param('provider') provider: string, @Req() req: any, @Body() body: any) {
    return this.business.connect(id, req.currentAccountId, provider, body, req.currentUser.id);
  }
  @Delete('companies/:id/connections/:provider') disconnect(@Param('id') id: string, @Param('provider') provider: string, @Req() req: any, @Body() body: any) {
    return this.business.disconnect(id, req.currentAccountId, provider, body?.revision, req.currentUser.id);
  }
  @Post('companies/:id/connections/:provider/sync') sync(@Param('id') id: string, @Param('provider') provider: string, @Req() req: any) {
    return this.business.sync(id, req.currentAccountId, provider, req.currentUser.id);
  }
}
