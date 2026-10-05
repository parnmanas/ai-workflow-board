import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../../entities/User';
import { Account } from '../../entities/Account';
import { SystemSetting } from '../../entities/SystemSetting';
import { AuthController } from './auth.controller';
import { GoogleOAuthService } from '../../services/google-oauth.service';

@Module({
  imports: [TypeOrmModule.forFeature([User, Account, SystemSetting])],
  controllers: [AuthController],
  providers: [GoogleOAuthService],
})
export class AuthModule {}
