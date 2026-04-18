import { Module } from '@nestjs/common';
import { EmbeddingService } from '../../services/embedding.service';
import { GitHubConnectorService } from '../../services/github-connector.service';

/**
 * MCP-scoped service providers.
 *
 * EmbeddingService and GitHubConnectorService are only consumed inside
 * `modules/mcp/*` (the MCP tool layer). Previously they lived in
 * `SharedServicesModule` as `@Global()` providers — accessible everywhere
 * even though nothing outside `modules/mcp/` touched them. Narrowing them
 * to this module keeps the global scope limited to genuinely cross-cutting
 * services (LogService, AuthService, ActivityService, etc.).
 *
 * NestJS still wires the DataSource dependency through `@InjectDataSource()`
 * in each service constructor, so this module stays minimal.
 */
@Module({
  providers: [EmbeddingService, GitHubConnectorService],
  exports: [EmbeddingService, GitHubConnectorService],
})
export class McpServicesModule {}
