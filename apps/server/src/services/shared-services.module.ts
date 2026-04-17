import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ActivityLog } from '../entities/ActivityLog';
import { ApiKey } from '../entities/ApiKey';
import { Channel } from '../entities/Channel';
import { Comment } from '../entities/Comment';
import { Ticket } from '../entities/Ticket';
import { User } from '../entities/User';
import { Agent } from '../entities/Agent';
import { AgentChannelIdentity } from '../entities/AgentChannelIdentity';
import { BoardColumn } from '../entities/BoardColumn';
import { RelationTuple } from '../entities/RelationTuple';
import { ActivityService } from './activity.service';
import { AuthService } from './auth.service';
import { ApiKeyService } from './api-key.service';
import { DiscordService } from './discord.service';
import { LogService } from './log.service';
import { NotificationService } from './notification.service';
import { SystemCommentService } from './system-comment.service';
import { ReBACService } from './rebac.service';
import { MentionService } from './mention.service';

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([ActivityLog, ApiKey, Agent, AgentChannelIdentity, Channel, Comment, Ticket, User, BoardColumn, RelationTuple]),
  ],
  providers: [
    ActivityService,
    AuthService,
    ApiKeyService,
    DiscordService,
    LogService,
    NotificationService,
    SystemCommentService,
    ReBACService,
    MentionService,
  ],
  exports: [
    ActivityService,
    AuthService,
    ApiKeyService,
    DiscordService,
    LogService,
    NotificationService,
    SystemCommentService,
    ReBACService,
    MentionService,
  ],
})
export class SharedServicesModule {}
