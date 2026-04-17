import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { WorkspacesModule } from './modules/workspaces/workspaces.module';
import { BoardsModule } from './modules/boards/boards.module';
import { ColumnsModule } from './modules/columns/columns.module';
import { TicketsModule } from './modules/tickets/tickets.module';
import { UsersModule } from './modules/users/users.module';
import { AgentsModule } from './modules/agents/agents.module';
import { PromptTemplatesModule } from './modules/prompt-templates/prompt-templates.module';
import { ChannelsModule } from './modules/channels/channels.module';
import { ApiKeysModule } from './modules/api-keys/api-keys.module';
import { ActivityModule } from './modules/activity/activity.module';
import { AgentApiModule } from './modules/agent-api/agent-api.module';
import { QaModule } from './modules/qa/qa.module';
import { HealthModule } from './modules/health/health.module';
import { McpModule } from './modules/mcp/mcp.module';
import { AdminModule } from './modules/admin/admin.module';
import { EventsModule } from './modules/events/events.module';
import { SharedServicesModule } from './services/shared-services.module';
import { ChatRoomsModule } from './modules/chat-rooms/chat-rooms.module';
import { ResourcesModule } from './modules/resources/resources.module';
import { CredentialsModule } from './modules/credentials/credentials.module';
import { AgentLogsModule } from './modules/agent-logs/agent-logs.module';

@Module({
  imports: [
    DatabaseModule,
    SharedServicesModule,
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', '..', 'client', 'dist'),
      exclude: ['/api{*path}', '/mcp{*path}'],
    }),
    AuthModule,
    WorkspacesModule,
    BoardsModule,
    ColumnsModule,
    TicketsModule,
    UsersModule,
    AgentsModule,
    PromptTemplatesModule,
    ChannelsModule,
    ApiKeysModule,
    ActivityModule,
    AgentApiModule,
    QaModule,
    HealthModule,
    McpModule,
    AdminModule,
    EventsModule,
    ChatRoomsModule,
    ResourcesModule,
    CredentialsModule,
    AgentLogsModule,
  ],
})
export class AppModule {}
