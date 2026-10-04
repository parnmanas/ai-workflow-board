import { Module } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { VoiceController, VoiceLabController } from './voice.controller';
import { VoiceService } from './voice.service';

/**
 * 음성 게이트웨이 — 엔티티가 없다. 설정은 SystemSettings `voice.*`(voice-config.ts), 오디오는
 * 저장하지 않고 공급자와 화면 사이를 지나가기만 한다. docs/voice-operator.md 참조.
 */
@Module({
  controllers: [VoiceController, VoiceLabController],
  providers: [VoiceService, AuthGuard, AdminGuard, PermissionGuard],
  exports: [VoiceService],
})
export class VoiceModule {}
