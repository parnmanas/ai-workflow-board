import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Agent } from '../../entities/Agent';
import { AgentSkillAssignment } from '../../entities/AgentSkillAssignment';
import { RunSkillSnapshot } from '../../entities/RunSkillSnapshot';
import { Skill } from '../../entities/Skill';
import { SkillProposal } from '../../entities/SkillProposal';
import { SkillVersion } from '../../entities/SkillVersion';
import { SkillTap } from '../../entities/SkillTap';
import { RunSkillSnapshotService } from './run-skill-snapshot.service';
import { SkillsController } from './skills.controller';
import { SkillsService } from './skills.service';
import { SkillRegistryController } from './skill-registry.controller';
import { SkillSyncService } from './skill-sync.service';
import { SkillTapService } from './skill-tap.service';
import { BuiltinSkillPackService } from './builtin-skill-pack.service';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';

@Module({
  imports: [TypeOrmModule.forFeature([
    Skill,
    SkillVersion,
    AgentSkillAssignment,
    RunSkillSnapshot,
    SkillProposal,
    SkillTap,
    Agent,
  ])],
  controllers: [SkillsController, SkillRegistryController],
  providers: [
    SkillsService,
    RunSkillSnapshotService,
    SkillSyncService,
    SkillTapService,
    BuiltinSkillPackService,
    AuthGuard,
    PermissionGuard,
  ],
  exports: [SkillsService, RunSkillSnapshotService, SkillTapService, BuiltinSkillPackService],
})
export class SkillsModule {}
