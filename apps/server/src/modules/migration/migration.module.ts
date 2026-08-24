import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MigrationRun } from '../../entities/MigrationRun';
import { DeploymentsModule } from '../deployments/deployment.module';
import { MigrationExportController } from './migration-export.controller';
import { MigrationImportController } from './migration-import.controller';
import { MigrationRunService } from './migration-run.service';
import { MigrationExportGuard } from '../../common/guards/migration-export.guard';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';

/**
 * Live pull import (ticket 0f638509). `InstanceQuiesceService`/`ApiKeyService`는
 * @Global() 서비스라 여기 다시 나열하지 않는다. `AuthGuard`/`AdminGuard`는
 * @Global()이 아니다 — admin.module.ts와 마찬가지로 `@UseGuards(AdminGuard)`를
 * 쓰는 모듈이라면 각자 자기 providers[]에 직접 등록해야 한다(agent-logs.module.ts
 * 등 다른 모듈도 같은 패턴). DeploymentsModule은 export 컨트롤러가 소스 커밋
 * SHA를 읽는 데 필요해 명시적으로 가져온다.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([MigrationRun]),
    DeploymentsModule,
  ],
  controllers: [MigrationExportController, MigrationImportController],
  providers: [MigrationRunService, MigrationExportGuard, AuthGuard, AdminGuard],
})
export class MigrationModule {}
