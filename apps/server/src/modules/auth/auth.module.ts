import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../../entities/User';
import { Account } from '../../entities/Account';
import { SystemSetting } from '../../entities/SystemSetting';
import { UserDevice } from '../../entities/UserDevice';
import { AuthController } from './auth.controller';
import { GoogleOAuthService } from '../../services/google-oauth.service';
import { DeviceAuthService } from './device-auth.service';

import { McpOAuthModule } from '../mcp-oauth/mcp-oauth.module';

@Module({
  imports: [McpOAuthModule, TypeOrmModule.forFeature([User, Account, SystemSetting, UserDevice])],
  controllers: [AuthController],
  providers: [GoogleOAuthService, DeviceAuthService],
})
export class AuthModule {}
