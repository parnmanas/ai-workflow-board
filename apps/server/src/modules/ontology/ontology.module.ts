import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Resource } from '../../entities/Resource';
import { Credential } from '../../entities/Credential';
import { OntologyExtractionService } from './ontology-extraction.service';

// ticket e14ef1c9 (DESIGN.md 축 1) — 이 모듈에는 아직 컨트롤러/MCP 툴이
// 없다. graph_status 같은 lifecycle 배선(ticket #6, 미배정)이 이
// OntologyExtractionService를 실제로 트리거하기 전까지는 DI 대기 상태다 —
// 그래도 AppModule에 등록해 둬야 그 후속 티켓이 곧바로 주입받아 쓸 수
// 있다(@InjectRepository(Resource)/@InjectRepository(Credential)가 이미
// ResourcesModule과 같은 엔티티를 forFeature하므로 중복 등록이지만, Nest는
// 모듈별 forFeature 등록을 독립적으로 허용한다 — 두 모듈이 같은 리포지토리
// 인스턴스를 공유해도 문제 없음).
@Module({
  imports: [TypeOrmModule.forFeature([Resource, Credential])],
  providers: [OntologyExtractionService],
  exports: [OntologyExtractionService],
})
export class OntologyModule {}
