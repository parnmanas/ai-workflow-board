import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join, sep } from 'path';
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
import { QaScenarioModule } from './modules/qa/qa-scenario.module';
import { SecurityProfileModule } from './modules/security/security-profile.module';
import { HealthModule } from './modules/health/health.module';
import { McpModule } from './modules/mcp/mcp.module';
import { AdminModule } from './modules/admin/admin.module';
import { EventsModule } from './modules/events/events.module';
import { SharedServicesModule } from './services/shared-services.module';
import { ChatRoomsModule } from './modules/chat-rooms/chat-rooms.module';
import { ResourcesModule } from './modules/resources/resources.module';
import { ActionsModule } from './modules/actions/actions.module';
import { CredentialsModule } from './modules/credentials/credentials.module';
import { AgentLogsModule } from './modules/agent-logs/agent-logs.module';
import { MentionsModule } from './modules/mentions/mentions.module';
import { WorkspaceRolesModule } from './modules/workspace-roles/workspace-roles.module';
import { AgentManagerModule } from './modules/agent-manager/agent-manager.module';
import { UserChannelsModule } from './modules/user-channels/user-channels.module';
import { ColumnPoliciesModule } from './modules/column-policies/column-policies.module';
import { BenchmarksModule } from './modules/benchmarks/benchmarks.module';
import { WorkspaceScheduleModule } from './modules/workspace-schedule/workspace-schedule.module';
import { FeaturesModule } from './modules/features/features.module';
import { HandoffModule } from './modules/handoff/handoff.module';
import { WorkflowFunctionsModule } from './modules/workflow-functions/workflow-functions.module';
import { SkillsModule } from './modules/skills/skills.module';
import { ArtifactRefsModule } from './modules/artifact-refs/artifact-refs.module';
import { OutreachModule } from './modules/outreach/outreach.module';
import { OrchestrationModule } from './modules/orchestration/orchestration.module';
import { OntologyModule } from './modules/ontology/ontology.module';
import { MigrationModule } from './modules/migration/migration.module';

@Module({
  imports: [
    DatabaseModule,
    SharedServicesModule,
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', '..', 'client', 'dist'),
      // /assets 는 SPA fallback(index.html) 대상에서 제외한다. express.static 이 먼저
      // 실제 파일을 서빙하므로 존재하는 해시 청크는 그대로 나가고, 여기 걸리는 건
      // "파일이 없는" /assets/*.js 뿐이다 — 재배포로 해시가 바뀐 뒤 stale 탭이 구
      // 청크를 lazy-import 하면 기존엔 200 text/html(index.html)로 응답해 브라우저의
      // strict MIME 체크를 위반했다(ticket 2cae7314). 제외하면 매칭되는 라우트가 없어
      // 정상 404 로 떨어져 dynamic import 가 명확한 실패로 reject 된다.
      exclude: ['/api{*path}', '/mcp{*path}', '/assets{*path}'],
      serveStaticOptions: {
        // Vite emits hashed filenames inside /assets/ (index-<hash>.js etc.) so
        // those are safe to cache forever. index.html and anything at the root
        // must NOT be cached — otherwise a redeploy ships new hashed bundles
        // but browsers keep loading the old index.html which points at the
        // *previous* hash and never picks up the new code. This has been the
        // source of "my fix isn't live" reports for a while.
        setHeaders: (res, path) => {
          if (path.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
          } else if (path.includes(`${sep}assets${sep}`)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          } else {
            // Other root-level files (favicon, robots) — modest cache.
            res.setHeader('Cache-Control', 'public, max-age=3600');
          }
        },
      },
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
    QaScenarioModule,
    SecurityProfileModule,
    HealthModule,
    McpModule,
    AdminModule,
    EventsModule,
    ChatRoomsModule,
    ResourcesModule,
    ActionsModule,
    CredentialsModule,
    AgentLogsModule,
    MentionsModule,
    WorkspaceRolesModule,
    AgentManagerModule,
    UserChannelsModule,
    ColumnPoliciesModule,
    BenchmarksModule,
    WorkspaceScheduleModule,
    FeaturesModule,
    HandoffModule,
    WorkflowFunctionsModule,
    SkillsModule,
    ArtifactRefsModule,
    OutreachModule,
    OrchestrationModule,
    OntologyModule,
    MigrationModule,
  ],
})
export class AppModule {}
