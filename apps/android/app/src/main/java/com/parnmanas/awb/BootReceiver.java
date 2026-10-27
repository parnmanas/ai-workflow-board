package com.parnmanas.awb;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import com.parnmanas.awb.voice.VoiceService;

/**
 * 재부팅 뒤 — 지금 서버에서 상시 음성을 켜 두었으면 "탭하면 다시 듣습니다" 알림을 띄운다.
 *
 * 부팅 브로드캐스트에서는 마이크 포그라운드 서비스를 시작할 수 없다(Android 14+ 의 while-in-use 제한 ·
 * Android 15+ 의 BOOT_COMPLETED 제한). 앱이 한 번 보이면 MainActivity 가 서비스를 되살린다.
 */
public class BootReceiver extends BroadcastReceiver {
  @Override
  public void onReceive(Context context, Intent intent) {
    if (intent == null || !Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
    Server s = Servers.active(context);
    if (s == null || !s.voiceEnabled || s.deviceToken.isEmpty()) return;
    VoiceService.postResumeNotice(context);
  }
}
