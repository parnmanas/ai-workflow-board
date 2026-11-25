import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Account } from '../../entities/Account';
import { McpOAuthGrant } from '../../entities/McpOAuthGrant';
import { McpOAuthController } from './mcp-oauth.controller';
import { McpOAuthService } from './mcp-oauth.service';

@Module({ imports: [TypeOrmModule.forFeature([Account, McpOAuthGrant])], controllers: [McpOAuthController],
  providers: [McpOAuthService], exports: [McpOAuthService] })
export class McpOAuthModule {}
