import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

// runtime_key 는 배정 대상이다 — 실행 신원(`rt-…`), 공용(`*`), 프로젝트(`project:<id>`).
// modules/skills/skill-assignment-target.ts, docs/skills.md "배정 범위".

@Entity('runtime_skill_assignments')
@Index('idx_runtime_skill_scope', ['account_id', 'runtime_key', 'skill_id'], { unique: true })
export class RuntimeSkillAssignment {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar' }) account_id: string;
  @Column({ type: 'varchar' }) runtime_key: string;
  @Column({ type: 'varchar' }) skill_id: string;
  @Column({ type: 'varchar' }) skill_version_id: string;
  @Column({ type: 'varchar', default: '' }) assigned_by: string;
  /** 실행 범위 배정의 사람이 읽는 대상(`<Host>/<label>` 등). runtime_key 는 해시라 화면이 이것을 보인다. */
  @Column({ type: 'varchar', default: '' }) target_label: string;
  @CreateDateColumn() created_at: Date;
}
