import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Resource } from '../../entities/Resource';
import { Credential } from '../../entities/Credential';
import { ResourcesController } from './resources.controller';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';

@Module({
  imports: [TypeOrmModule.forFeature([Resource, Credential])],
  controllers: [ResourcesController],
  providers: [AuthGuard, PermissionGuard],
})
export class ResourcesModule {}
