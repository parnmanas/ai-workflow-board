import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Resource } from '../../entities/Resource';
import { Credential } from '../../entities/Credential';
import { OntologyExtractionService } from './ontology-extraction.service';
import { OntologyResolverService } from './ontology-resolver.service';
import { OntologyQueryService } from './ontology-query.service';
import { OntologyIncrementalSchedulerService } from './incremental-scheduler.service';
import { OntologyStaleSweepService } from './incremental/sweep.service';

// ticket e14ef1c9/e52e7f64/20b07fc8/964014f5 (DESIGN.md 축 1/3/4) — 이 모듈에는 아직
// 컨트롤러/MCP 툴이 없다. graph_status 같은 lifecycle 배선(ticket #6,
// 미배정)이 이 서비스들을 실제로 트리거하기 전까지는 DI 대기 상태다 —
// 그래도 AppModule에 등록해 둬야 그 후속 티켓이 곧바로 주입받아 쓸 수
// 있다(@InjectRepository(Resource)/@InjectRepository(Credential)가 이미
// ResourcesModule과 같은 엔티티를 forFeature하므로 중복 등록이지만, Nest는
// 모듈별 forFeature 등록을 독립적으로 허용한다 — 두 모듈이 같은 리포지토리
// 인스턴스를 공유해도 문제 없음). OntologyStaleSweepService는
// OnModuleInit이라 이 모듈이 AppModule에 등록되는 즉시 백그라운드 스윕이
// 시작된다(완료조건 3) — Phase A/B/C 트리거 자체가 아직 없어도 스윕은
// 독립적으로 동작(대기열이 비어 있으면 텔레메트리도 로깅하지 않는다,
// sweep.service.ts 참고).
@Module({
  imports: [TypeOrmModule.forFeature([Resource, Credential])],
  providers: [
    OntologyExtractionService,
    OntologyResolverService,
    OntologyQueryService,
    OntologyIncrementalSchedulerService,
    OntologyStaleSweepService,
  ],
  exports: [
    OntologyExtractionService,
    OntologyResolverService,
    OntologyQueryService,
    OntologyIncrementalSchedulerService,
    OntologyStaleSweepService,
  ],
})
export class OntologyModule {}
