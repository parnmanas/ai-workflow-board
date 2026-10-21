import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RuntimeSkillAssignment } from '../../entities/RuntimeSkillAssignment';
import { RunSkillSnapshot } from '../../entities/RunSkillSnapshot';
import { Skill } from '../../entities/Skill';
import { SkillVersion } from '../../entities/SkillVersion';
import type { KnowledgeSkillLine } from '../../common/ticket-work-order';
import { skillIndex, skillManifestFor, type ManifestEntry } from './knowledge';

/** 런 스냅샷 manifest 한 줄 — 정의는 knowledge.ts(공용 계산과 같은 모양). */
export type PinnedSkillManifestEntry = ManifestEntry;

@Injectable()
export class RunSkillSnapshotService {
  constructor(
    @InjectRepository(RunSkillSnapshot) private readonly snapshots: Repository<RunSkillSnapshot>,
    @InjectRepository(RuntimeSkillAssignment) private readonly assignments: Repository<RuntimeSkillAssignment>,
    @InjectRepository(SkillVersion) private readonly versions: Repository<SkillVersion>,
    @InjectRepository(Skill) private readonly skills: Repository<Skill>,
  ) {}

  /** 이 실행에 해당하는 skill(공용 + 프로젝트 + 실행, 좁은 범위 우선)의 핀된 manifest — knowledge.ts. */
  async manifestFor(args: { accountId: string; runtimeKey?: string | null; projectId?: string | null }): Promise<PinnedSkillManifestEntry[]> {
    return skillManifestFor({ assignments: this.assignments, versions: this.versions, skills: this.skills }, args);
  }

  async resolve(args: {
    accountId: string;
    runId: string;
    agentId: string;
    /** 티켓의 프로젝트 — 그 프로젝트에 배정된 skill 도 실린다. */
    projectId?: string | null;
  }): Promise<RunSkillSnapshot> {
    const existing = await this.snapshots.findOne({
      where: { account_id: args.accountId, run_id: args.runId },
    });
    if (existing) return existing;

    const manifest = await this.manifestFor({ accountId: args.accountId, runtimeKey: args.agentId, projectId: args.projectId });
    const digest = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
    try {
      return await this.snapshots.save(this.snapshots.create({
        account_id: args.accountId,
        run_id: args.runId,
        agent_id: args.agentId,
        manifest,
        digest,
        status: 'pinned',
        locked_at: null,
      }));
    } catch (error) {
      // Two dispatch producers can race on the same logical run. The unique
      // (account, run) boundary chooses the winner; every loser must reuse
      // that exact immutable snapshot instead of calculating a replacement.
      const winner = await this.snapshots.findOne({
        where: { account_id: args.accountId, run_id: args.runId },
      });
      if (winner) return winner;
      throw error;
    }
  }

  /** 목차 — 이름·설명·버전·범위만(본문 없이). 지시문과 `get_knowledge` 가 보여 준다. */
  static index(manifest: readonly PinnedSkillManifestEntry[]): KnowledgeSkillLine[] {
    return skillIndex(manifest);
  }

  async lock(accountId: string, runId: string): Promise<void> {
    await this.snapshots.update(
      { account_id: accountId, run_id: runId, status: 'pinned' },
      { status: 'locked', locked_at: new Date() },
    );
  }
}
