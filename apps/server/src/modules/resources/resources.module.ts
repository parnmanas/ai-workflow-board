import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Resource } from '../../entities/Resource';
import { Credential } from '../../entities/Credential';
import { ResourcesController } from './resources.controller';
import { ResourceMediaController } from './resource-media.controller';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';

@Module({
  imports: [TypeOrmModule.forFeature([Resource, Credential])],
  controllers: [ResourcesController, ResourceMediaController],
  providers: [AuthGuard, PermissionGuard],
})
export class ResourcesModule {}
