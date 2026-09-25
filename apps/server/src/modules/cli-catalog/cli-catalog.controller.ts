import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Controller, Get, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { CLI_CATALOG, type CliDescriptor } from '../../common/cli-catalog';

/**
 * `GET /api/cli-catalog` — 서버의 CLI 카탈로그(common/cli-catalog.ts)를 그대로
 * 돌려 준다. 로그인한 사용자면 누구나(admin 불필요): CLI picker · credential
 * 화면 · 자동 로그인 다이얼로그가 각자 하드코딩하던 표를 이걸로 대체하기 위한
 * 것이고, 비밀은 하나도 없다. 엔티티/DB 없음.
 */
@ApiBearerAuth('user-session')
@ApiTags('cli-catalog')
@Controller('api/cli-catalog')
@UseGuards(AuthGuard)
export class CliCatalogController {
  @Get()
  list(): { clis: readonly CliDescriptor[] } {
    return { clis: CLI_CATALOG };
  }
}
