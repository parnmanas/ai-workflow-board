import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { ApiKeyService } from '../../services/api-key.service';
import { ActivityService } from '../../services/activity.service';

export const MIGRATION_EXPORT_SCOPE = 'migration_export';

/**
 * 소스 서버의 migration export 엔드포인트 전용 가드 (ticket 0f638509).
 *
 * AgentAuthGuard를 재사용하지 않는다 — 이 엔드포인트는 인스턴스 전체 DB(모든
 * 워크스페이스의 크리덴셜 포함)를 순서대로 스트리밍하는 표면이라, dev-mode /
 * 정적 ENV 키 bypass 같은 완화 경로를 하나도 두지 않는다. 항상 DB에 저장된
 * 실제 `scope=migration_export` ApiKey만 허용 — 설계 스케치가 명시한
 * "authz 게이트와 감사 로그 필수" 리스크에 대한 직접 대응이다.
 *
 * 거부(누락/무효 키, 잘못된 scope)는 전부 `migration_export_denied`
 * ActivityLog로 남긴다(리뷰 라운드1 P3) — 원문 키는 절대 기록하지 않고,
 * 유효한 키가 발견된 경우에만 그 키의 id/name을 actor로 남긴다.
 */
@Injectable()
export class MigrationExportGuard implements CanActivate {
  constructor(
    private readonly apiKeyService: ApiKeyService,
    private readonly activityService: ActivityService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const providedKey = request.headers['x-agent-key'] as string | undefined;
    if (!providedKey) {
      await this._auditDenied(request, 'missing_x_agent_key_header');
      throw new UnauthorizedException('Missing X-Agent-Key header');
    }

    const result = await this.apiKeyService.validateApiKey(providedKey);
    if (!result.valid || !result.apiKey) {
      await this._auditDenied(request, `invalid_key:${result.reason || 'unknown'}`);
      throw new UnauthorizedException(result.reason || 'Invalid or missing API key');
    }
    if (result.apiKey.scope !== MIGRATION_EXPORT_SCOPE) {
      await this._auditDenied(request, 'wrong_scope', result.apiKey.id, result.apiKey.name);
      throw new ForbiddenException(`This endpoint requires an API key with scope=${MIGRATION_EXPORT_SCOPE}`);
    }

    request.apiKey = result.apiKey;
    return true;
  }

  private async _auditDenied(request: any, reason: string, actorId = '', actorName = ''): Promise<void> {
    try {
      await this.activityService.logActivity({
        entity_type: 'migration',
        entity_id: String(request?.params?.entity || request?.route?.path || 'export'),
        action: 'migration_export_denied',
        field_changed: reason,
        actor_id: actorId,
        actor_name: actorName,
        ticket_id: '',
        trigger_source: 'migration_export',
      });
    } catch {
      // 감사 기록 실패가 거부 자체를 막아서는 안 된다 — 이미 UnauthorizedException/
      // ForbiddenException을 던지는 흐름이라 여기서 실패해도 access는 여전히 거부된다.
    }
  }
}
