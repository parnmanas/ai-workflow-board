import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '../../entities/Channel';
import { ChannelsController } from './channels.controller';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';

@Module({
  imports: [TypeOrmModule.forFeature([Channel])],
  controllers: [ChannelsController],
  providers: [AuthGuard, PermissionGuard],
})
export class ChannelsModule {}
