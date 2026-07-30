import { MigrationInterface, QueryRunner } from 'typeorm';
import { PromptTemplate } from '../../entities/PromptTemplate';

const MARKER = 'AWB Artifact reference 규칙';
const RULE =
  '\n\n> 🔗 **AWB Artifact reference 규칙** — Ticket, Agent, Board, Action, Function, Schedule을 출력할 때 ' +
  '반드시 `#[type:<full-uuid>|사람이 읽을 수 있는 이름]`을 사용하고 축약 ID만 쓰지 마라. ' +
  '존재 또는 권한을 확인할 수 없으면 가짜 ref 대신 이름, 전체 안정 ID, 연결 불가 사유를 명시하라.';

export class AddArtifactReferencePromptRule1760000000070 implements MigrationInterface {
  name = 'AddArtifactReferencePromptRule1760000000070';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const repo = queryRunner.manager.getRepository(PromptTemplate);
    const rows = await repo.find({ where: { category: 'default_workflow' } });
    for (const row of rows) {
      if (!row.content.includes(MARKER)) {
        row.content += RULE;
        await repo.save(row);
      }
    }
  }

  public async down(): Promise<void> {
    // Prompt refresh migrations intentionally preserve operator-authored content.
  }
}
