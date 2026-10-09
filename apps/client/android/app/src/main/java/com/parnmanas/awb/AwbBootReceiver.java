package com.parnmanas.awb;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import androidx.core.content.ContextCompat;

/**
 * 재부팅 후 백그라운드 듣기 복원 — 껐다 켜면 조용히 꺼져 있는 게 아니라
 * 켜 두었던 상태로 돌아온다. 껐던 상태면 아무 일도 하지 않는다.
 */
public class AwbBootReceiver extends BroadcastReceiver {
  @Override
  public void onReceive(Context context, Intent intent) {
    if (intent == null) return;
    String action = intent.getAction();
    if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
        && !"android.intent.action.LOCKED_BOOT_COMPLETED".equals(action)) {
      return;
    }
    SharedPreferences prefs = context.getSharedPreferences(AwbWakeService.PREFS, Context.MODE_PRIVATE);
    if (!prefs.getBoolean(AwbWakeService.PREF_ENABLED, false)) return;
    // DIRECT_BOOT 중에는 저장소 잠금이 풀리기 전이라 토큰을 못 읽는다 — 일반 부팅만 받는다.
    if ("android.intent.action.LOCKED_BOOT_COMPLETED".equals(action)) return;
    Intent start = new Intent(context, AwbWakeService.class);
    start.setAction(AwbWakeService.ACTION_START);
    try {
      ContextCompat.startForegroundService(context, start);
    } catch (Exception ignored) {
      // 백그라운드 실행 제한(제조사/절전)이 막으면 사용자가 앱에서 다시 켠다.
    }
  }
}
