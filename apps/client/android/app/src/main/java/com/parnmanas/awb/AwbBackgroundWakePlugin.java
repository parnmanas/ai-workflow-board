package com.parnmanas.awb;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * 백그라운드 wake 브릿지 — WebView(React)가 네이티브 포그라운드 서비스를 켜고 끈다.
 *
 * 권한: RECORD_AUDIO(필수) + POST_NOTIFICATIONS(API 33+, 상태바 상시 알림용).
 * 토큰·서버 주소는 서비스가 재부팅 후에도 스스로 깨어나야 해서 private prefs에 둔다
 * (WebView localStorage와 같은 민감도 — 루팅된 단말에서는 둘 다 보인다).
 */
@CapacitorPlugin(
    name = "AwbBackgroundWake",
    permissions = {
      @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = AwbBackgroundWakePlugin.ALIAS_MIC),
      @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = AwbBackgroundWakePlugin.ALIAS_NOTIF)
    })
public class AwbBackgroundWakePlugin extends Plugin {
  static final String ALIAS_MIC = "microphone";
  static final String ALIAS_NOTIF = "notifications";

  @PluginMethod
  public void isSupported(PluginCall call) {
    // AudioRecord는 전부 되지만, 마이크 타입 포그라운드 서비스가 의미를 갖는 건 API 29+다.
    // 그 아래에서는 돌아가되 OS가 언제든 죽일 수 있어 "지원하되 불안정"으로 알린다.
    JSObject ret = new JSObject();
    ret.put("supported", true);
    ret.put("reliable", Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q);
    call.resolve(ret);
  }

  @PluginMethod
  public void getStatus(PluginCall call) {
    SharedPreferences prefs = getContext().getSharedPreferences(AwbWakeService.PREFS, Context.MODE_PRIVATE);
    JSObject ret = new JSObject();
    ret.put("running", AwbWakeService.isRunning());
    ret.put("enabled", prefs.getBoolean(AwbWakeService.PREF_ENABLED, false));
    ret.put("mic", getPermissionState(ALIAS_MIC) == PermissionState.GRANTED);
    ret.put("notifications", notificationsGranted());
    ret.put("batteryOptimized", isBatteryOptimized());
    call.resolve(ret);
  }

  @PluginMethod
  public void requestPermissions(PluginCall call) {
    // POST_NOTIFICATIONS는 API 33+에만 있다 — 아래에서는 설치 시 허용된 것으로 본다.
    if (Build.VERSION.SDK_INT >= 33) {
      requestPermissionForAliases(new String[] { ALIAS_MIC, ALIAS_NOTIF }, call, "permissionCallback");
    } else {
      requestPermissionForAlias(ALIAS_MIC, call, "permissionCallback");
    }
  }

  @PermissionCallback
  private void permissionCallback(PluginCall call) {
    JSObject ret = new JSObject();
    ret.put("mic", getPermissionState(ALIAS_MIC) == PermissionState.GRANTED);
    ret.put("notifications", notificationsGranted());
    call.resolve(ret);
  }

  @PluginMethod
  public void startListening(PluginCall call) {
    String serverUrl = call.getString("serverUrl", "");
    String token = call.getString("token", "");
    if (serverUrl == null || serverUrl.isEmpty()) {
      call.reject("serverUrl이 필요합니다 — 앱 설정에서 서버 주소를 먼저 입력하세요");
      return;
    }
    if (token == null || token.isEmpty()) {
      call.reject("로그인이 필요합니다 — 먼저 로그인하세요");
      return;
    }
    if (getPermissionState(ALIAS_MIC) != PermissionState.GRANTED) {
      call.reject("마이크 권한이 필요합니다");
      return;
    }
    Intent intent = new Intent(getContext(), AwbWakeService.class);
    intent.setAction(AwbWakeService.ACTION_START);
    intent.putExtra(AwbWakeService.EXTRA_SERVER_URL, serverUrl);
    intent.putExtra(AwbWakeService.EXTRA_TOKEN, token);
    try {
      ContextCompat.startForegroundService(getContext(), intent);
    } catch (Exception e) {
      call.reject("서비스를 시작하지 못했습니다: " + e.getMessage());
      return;
    }
    JSObject ret = new JSObject();
    ret.put("running", true);
    call.resolve(ret);
  }

  @PluginMethod
  public void stopListening(PluginCall call) {
    Intent intent = new Intent(getContext(), AwbWakeService.class);
    intent.setAction(AwbWakeService.ACTION_STOP);
    try {
      getContext().startService(intent);
    } catch (Exception ignored) {
    }
    JSObject ret = new JSObject();
    ret.put("running", false);
    call.resolve(ret);
  }

  /** 절전 예외 요청 화면을 연다 — 허용은 사용자가 직접 켠다. 없어도 동작은 한다. */
  @PluginMethod
  public void openBatterySettings(PluginCall call) {
    try {
      Intent intent = new Intent(
          Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
          Uri.parse("package:" + getContext().getPackageName()));
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      getContext().startActivity(intent);
      call.resolve();
    } catch (Exception e) {
      call.reject("절전 설정 화면을 열지 못했습니다");
    }
  }

  private boolean notificationsGranted() {
    if (Build.VERSION.SDK_INT < 33) return true;
    return getPermissionState(ALIAS_NOTIF) == PermissionState.GRANTED;
  }

  private boolean isBatteryOptimized() {
    try {
      PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
      return pm != null && !pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
    } catch (Exception e) {
      return false;
    }
  }
}
