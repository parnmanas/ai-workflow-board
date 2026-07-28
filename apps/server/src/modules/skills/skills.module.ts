import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Agent } from '../../entities/Agent';
import { AgentSkillAssignment } from '../../entities/AgentSkillAssignment';
import { RunSkillSnapshot } from '../../entities/RunSkillSnapshot';
import { Skill } from '../../entities/Skill';
import { SkillProposal } from '../../entities/SkillProposal';
import { SkillVersion } from '../../entities/SkillVersion';
import { RunSkillSnapshotService } from './run-skill-snapshot.service';
import { SkillsController } from './skills.controller';
import { SkillsService } from './skills.service';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';

@Module({
  imports: [TypeOrmModule.forFeature([
    Skill,
    SkillVersion,
    AgentSkillAssignment,
    RunSkillSnapshot,
    SkillProposal,
    Agent,
  ])],
  controllers: [SkillsController],
  providers: [SkillsService, RunSkillSnapshotService, AuthGuard, PermissionGuard],
  exports: [SkillsService, RunSkillSnapshotService],
})
export class SkillsModule {}
