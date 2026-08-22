import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Resource } from '../../entities/Resource';
import { Credential } from '../../entities/Credential';
import { OntologyExtractionService } from './ontology-extraction.service';
import { OntologyResolverService } from './ontology-resolver.service';
import { OntologyQueryService } from './ontology-query.service';
import { OntologyLifecycleService } from './ontology-lifecycle.service';
import { OntologyIncrementalSchedulerService } from './incremental-scheduler.service';
import { OntologyStaleSweepService } from './incremental/sweep.service';
import { OntologyController } from './ontology.controller';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';

// ticket e14ef1c9/e52e7f64/20b07fc8/964014f5/d35b7b7d/d22b83b4 (DESIGN.md 축
// 1/3/4/5/6) — OntologyController(ticket d22b83b4)가 이 모듈의 첫 REST
// 컨트롤러다. MCP 툴은 여전히 McpModule이 OntologyModule을 import해
// OntologyLifecycleService/OntologyQueryService를 ontology-tools.ts에
// 주입하는 것으로 별도 처리된다. OntologyStaleSweepService는 OnModuleInit이라
// 이 모듈이 AppModule에 등록되는 즉시 백그라운드 스윕이 시작된다(완료조건
// 3) — Phase A/B/C 트리거 자체가 아직 없어도 스윕은 독립적으로 동작(대기열이
// 비어 있으면 텔레메트리도 로깅하지 않는다, sweep.service.ts 참고).
// AuthGuard/PermissionGuard를 providers에 직접 등록하는 것은
// resources.module.ts와 같은 자세 — OntologyController가 @UseGuards(
// PermissionGuard)를 쓰는데 PermissionGuard 자체가 AuthGuard에 의존해서
// (Reflector, AuthGuard) 이 모듈 스코프 안에 둘 다 없으면 부팅 시
// UnknownDependenciesException으로 즉시 죽는다(실제로 겪음 — 아래
// providers 배열 없이 첫 부팅에서 재현됨).
// (@InjectRepository(Resource)/@InjectRepository(Credential)가 이미
// ResourcesModule과 같은 엔티티를 forFeature하므로 중복 등록이지만, Nest는
// 모듈별 forFeature 등록을 독립적으로 허용한다 — 두 모듈이 같은 리포지토리
// 인스턴스를 공유해도 문제 없음.)
@Module({
  imports: [TypeOrmModule.forFeature([Resource, Credential])],
  controllers: [OntologyController],
  providers: [
    OntologyExtractionService,
    OntologyResolverService,
    OntologyQueryService,
    OntologyLifecycleService,
    OntologyIncrementalSchedulerService,
    OntologyStaleSweepService,
    AuthGuard,
    PermissionGuard,
  ],
  exports: [
    OntologyExtractionService,
    OntologyResolverService,
    OntologyQueryService,
    OntologyLifecycleService,
    OntologyIncrementalSchedulerService,
    OntologyStaleSweepService,
  ],
})
export class OntologyModule {}
