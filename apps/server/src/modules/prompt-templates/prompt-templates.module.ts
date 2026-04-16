import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PromptTemplate } from '../../entities/PromptTemplate';
import { PromptTemplatesController } from './prompt-templates.controller';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';

@Module({
  imports: [TypeOrmModule.forFeature([PromptTemplate])],
  controllers: [PromptTemplatesController],
  providers: [AuthGuard, PermissionGuard],
})
export class PromptTemplatesModule {}
