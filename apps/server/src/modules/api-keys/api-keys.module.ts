import { Module } from '@nestjs/common';
import { ApiKeysController } from './api-keys.controller';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';

@Module({
  controllers: [ApiKeysController],
  providers: [AuthGuard, PermissionGuard],
})
export class ApiKeysModule {}
