import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserChannel } from '../../entities/UserChannel';
import { UserChannelsController } from './user-channels.controller';
import { UserChannelsService } from './user-channels.service';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';

@Module({
  imports: [TypeOrmModule.forFeature([UserChannel])],
  controllers: [UserChannelsController],
  providers: [UserChannelsService, AuthGuard, AdminGuard],
})
export class UserChannelsModule {}
