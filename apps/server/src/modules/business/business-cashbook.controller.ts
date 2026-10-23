import { Body, Controller, Get, Header, Param, Post, Req, UseGuards } from '@nestjs/common';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { BusinessCashbookService } from './business-cashbook.service';

@Controller('api/business/companies/:id/cashbook')
@UseGuards(PermissionGuard)
@RequirePermission(PERMISSIONS.MANAGE_BUSINESS)
export class BusinessCashbookController {
  constructor(private readonly cashbook: BusinessCashbookService) {}
  @Get('months/:month') @Header('Cache-Control', 'no-store')
  read(@Param('id') id: string, @Param('month') month: string, @Req() req: any) { return this.cashbook.read(id, req.currentAccountId, month); }
  @Post('entries')
  add(@Param('id') id: string, @Body() body: any, @Req() req: any) { return this.cashbook.add(id, req.currentAccountId, body, req.currentUser.id); }
  @Post('entries/:entryId/reconcile')
  reconcile(@Param('id') id: string, @Param('entryId') entryId: string, @Body() body: any, @Req() req: any) { return this.cashbook.reconcile(id, req.currentAccountId, entryId, body, req.currentUser.id); }
  @Post('entries/:entryId/void')
  void(@Param('id') id: string, @Param('entryId') entryId: string, @Body() body: any, @Req() req: any) { return this.cashbook.void(id, req.currentAccountId, entryId, body, req.currentUser.id); }
  @Post('months/:month/close')
  close(@Param('id') id: string, @Param('month') month: string, @Body() body: any, @Req() req: any) { return this.cashbook.close(id, req.currentAccountId, month, body, req.currentUser.id); }
  @Post('months/:month/reopen')
  reopen(@Param('id') id: string, @Param('month') month: string, @Body() body: any, @Req() req: any) { return this.cashbook.reopen(id, req.currentAccountId, month, body, req.currentUser.id); }
}
