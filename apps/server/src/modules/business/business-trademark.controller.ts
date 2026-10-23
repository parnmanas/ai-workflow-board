import { Body, Controller, Delete, Get, Header, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { BusinessTrademarkService } from './business-trademark.service';

@ApiBearerAuth('user-session')
@ApiTags('business')
@Controller('api/business/companies/:companyId/trademarks')
@UseGuards(PermissionGuard)
@RequirePermission(PERMISSIONS.MANAGE_BUSINESS)
export class BusinessTrademarkController {
  constructor(private readonly trademarks: BusinessTrademarkService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Param('companyId') companyId: string, @Req() req: any) {
    return this.trademarks.list(companyId, req.currentAccountId);
  }
  @Post()
  create(@Param('companyId') companyId: string, @Req() req: any, @Body() body: any) {
    return this.trademarks.save(companyId, req.currentAccountId, null, body, req.currentUser.id);
  }
  @Patch(':id')
  update(@Param('companyId') companyId: string, @Param('id') id: string, @Req() req: any, @Body() body: any) {
    return this.trademarks.save(companyId, req.currentAccountId, id, body, req.currentUser.id);
  }
  @Post(':id/draft')
  @Header('Cache-Control', 'no-store')
  draft(@Param('companyId') companyId: string, @Param('id') id: string, @Req() req: any, @Body() body: any) {
    return this.trademarks.draft(companyId, req.currentAccountId, id, body);
  }
  @Post(':id/mail')
  prepare(@Param('companyId') companyId: string, @Param('id') id: string, @Req() req: any, @Body() body: any) {
    return this.trademarks.prepareMail(companyId, req.currentAccountId, id, body, req.currentUser.id);
  }
  @Get(':id/mail/:mailId')
  @Header('Cache-Control', 'no-store')
  review(@Param('companyId') companyId: string, @Param('id') id: string, @Param('mailId') mailId: string, @Req() req: any) {
    return this.trademarks.review(companyId, req.currentAccountId, id, mailId);
  }
  @Delete(':id/mail/:mailId')
  discard(@Param('companyId') companyId: string, @Param('id') id: string, @Param('mailId') mailId: string, @Req() req: any, @Body() body: any) {
    return this.trademarks.discard(companyId, req.currentAccountId, id, mailId, body, req.currentUser.id);
  }
  @Post(':id/mail/:mailId/send')
  send(@Param('companyId') companyId: string, @Param('id') id: string, @Param('mailId') mailId: string, @Req() req: any, @Body() body: any) {
    return this.trademarks.send(companyId, req.currentAccountId, id, mailId, body, req.currentUser.id);
  }
  @Post(':id/mail/:mailId/delivery')
  delivery(@Param('companyId') companyId: string, @Param('id') id: string, @Param('mailId') mailId: string, @Req() req: any) {
    return this.trademarks.delivery(companyId, req.currentAccountId, id, mailId);
  }
  @Post(':id/mail/:mailId/reconcile')
  reconcile(@Param('companyId') companyId: string, @Param('id') id: string, @Param('mailId') mailId: string, @Req() req: any, @Body() body: any) {
    return this.trademarks.reconcile(companyId, req.currentAccountId, id, mailId, body, req.currentUser.id);
  }
}
