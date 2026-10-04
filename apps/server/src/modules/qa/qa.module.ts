import { Module } from '@nestjs/common';
import { QaController } from './qa.controller';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';

@Module({
  controllers: [QaController],
  providers: [AuthGuard, AdminGuard],
})
export class QaModule {}
