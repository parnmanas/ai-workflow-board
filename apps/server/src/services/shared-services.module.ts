import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ActivityLog } from '../entities/ActivityLog';
import { ApiKey } from '../entities/ApiKey';
import { Channel } from '../entities/Channel';
import { Comment } from '../entities/Comment';
import { Ticket } from '../entities/Ticket';
import { User } from '../entities/User';
import { Agent } from '../entities/Agent';
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
import { PresenceService } from './presence.service';

/**
 * Global cross-cutting services.
 *
 * Only truly ubiquitous services live here (Log, Auth, ApiKey, Activity,
 * ReBAC, Mention, Discord). Everything else is scoped to its feature module:
 *
 *   - EmbeddingService / GitHubConnectorService → `modules/mcp/mcp-services.module.ts`
 *   - NotificationService / SystemCommentService → provider only (they run as
 *     event-listener singletons via OnModuleInit; nothing injects them)
 *
 * Keeping `@Global()` here is still justified: LogService has 15+ consumers,
 * ApiKeyService 7+, ActivityService 6+ — propagating those through every
 * module's `imports` array would be pure noise.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([ActivityLog, ApiKey, Agent, Channel, Comment, Ticket, User, BoardColumn, RelationTuple]),
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
    PresenceService,
  ],
  exports: [
    ActivityService,
    AuthService,
    ApiKeyService,
    DiscordService,
    LogService,
    ReBACService,
    MentionService,
    PresenceService,
  ],
})
export class SharedServicesModule {}
