import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../../entities/User';
import { Workspace } from '../../entities/Workspace';
import { AuthController } from './auth.controller';

@Module({
  imports: [TypeOrmModule.forFeature([User, Workspace])],
  controllers: [AuthController],
})
export class AuthModule {}
