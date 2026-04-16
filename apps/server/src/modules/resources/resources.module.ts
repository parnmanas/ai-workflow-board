import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Resource } from '../../entities/Resource';
import { ResourcesController } from './resources.controller';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';

@Module({
  imports: [TypeOrmModule.forFeature([Resource])],
  controllers: [ResourcesController],
  providers: [AuthGuard, PermissionGuard],
})
export class ResourcesModule {}
