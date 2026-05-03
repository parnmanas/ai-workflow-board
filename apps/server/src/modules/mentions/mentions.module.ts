import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserMention } from '../../entities/UserMention';
import { Ticket } from '../../entities/Ticket';
import { BoardColumn } from '../../entities/BoardColumn';
import { MentionsController } from './mentions.controller';
import { MentionsService } from './mentions.service';
import { AuthGuard } from '../../common/guards/auth.guard';

@Module({
  imports: [TypeOrmModule.forFeature([UserMention, Ticket, BoardColumn])],
  controllers: [MentionsController],
  providers: [MentionsService, AuthGuard],
})
export class MentionsModule {}
