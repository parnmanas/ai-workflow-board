import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { ApiKeyService } from '../../services/api-key.service';

export const MIGRATION_EXPORT_SCOPE = 'migration_export';

/**
 * 소스 서버의 migration export 엔드포인트 전용 가드 (ticket 0f638509).
 *
 * AgentAuthGuard를 재사용하지 않는다 — 이 엔드포인트는 인스턴스 전체 DB(모든
 * 워크스페이스의 크리덴셜 포함)를 순서대로 스트리밍하는 표면이라, dev-mode /
 * 정적 ENV 키 bypass 같은 완화 경로를 하나도 두지 않는다. 항상 DB에 저장된
 * 실제 `scope=migration_export` ApiKey만 허용 — 설계 스케치가 명시한
 * "authz 게이트와 감사 로그 필수" 리스크에 대한 직접 대응이다.
 */
@Injectable()
export class MigrationExportGuard implements CanActivate {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const providedKey = request.headers['x-agent-key'] as string | undefined;
    if (!providedKey) {
      throw new UnauthorizedException('Missing X-Agent-Key header');
    }

    const result = await this.apiKeyService.validateApiKey(providedKey);
    if (!result.valid || !result.apiKey) {
      throw new UnauthorizedException(result.reason || 'Invalid or missing API key');
    }
    if (result.apiKey.scope !== MIGRATION_EXPORT_SCOPE) {
      throw new ForbiddenException(`This endpoint requires an API key with scope=${MIGRATION_EXPORT_SCOPE}`);
    }

    request.apiKey = result.apiKey;
    return true;
  }
}
