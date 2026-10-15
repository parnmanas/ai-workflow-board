package com.parnmanas.awb;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * 앱 private 저장소 — 서버 주소 · 단말 자격 · 상시 음성 스위치.
 *
 * 단말 토큰은 WebView localStorage 와 같은 민감도다(루팅된 단말에서는 둘 다 보인다). 서버는
 * 원문을 갖고 있지 않고, 로그아웃이나 "단말 회수" 로 즉시 무효가 된다.
 */
public final class Prefs {
  private static final String FILE = "awb_app";
  private static final String SERVER_URL = "server_url";
  private static final String DEVICE_TOKEN = "device_token";
  private static final String DEVICE_ID = "device_id";
  private static final String DEVICE_USER_ID = "device_user_id";
  private static final String SESSION_TOKEN = "session_token";
  private static final String VOICE_ENABLED = "voice_enabled";
  private static final String VOICE_ASKED = "voice_asked";

  private Prefs() {}

  private static SharedPreferences p(Context c) {
    return c.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
  }

  public static String serverUrl(Context c) {
    return p(c).getString(SERVER_URL, "");
  }

  public static void setServerUrl(Context c, String url) {
    p(c).edit().putString(SERVER_URL, url).apply();
  }

  public static String deviceToken(Context c) {
    return p(c).getString(DEVICE_TOKEN, "");
  }

  public static String deviceId(Context c) {
    return p(c).getString(DEVICE_ID, "");
  }

  /** 단말 자격을 받은 사용자 — 앱에서 다른 사람으로 로그인하면 자격을 새로 받는다. */
  public static String deviceUserId(Context c) {
    return p(c).getString(DEVICE_USER_ID, "");
  }

  public static void setDevice(Context c, String id, String token, String userId) {
    p(c).edit().putString(DEVICE_ID, id).putString(DEVICE_TOKEN, token).putString(DEVICE_USER_ID, userId).apply();
  }

  public static String sessionToken(Context c) {
    return p(c).getString(SESSION_TOKEN, "");
  }

  public static void setSessionToken(Context c, String token) {
    p(c).edit().putString(SESSION_TOKEN, token == null ? "" : token).apply();
  }

  /** 로그아웃 · 서버 변경 — 이 서버에서 받은 자격을 전부 버린다. 서버 주소와 음성 스위치는 남긴다. */
  public static void clearAuth(Context c) {
    p(c).edit().remove(DEVICE_ID).remove(DEVICE_TOKEN).remove(DEVICE_USER_ID).remove(SESSION_TOKEN).apply();
  }

  public static boolean voiceEnabled(Context c) {
    return p(c).getBoolean(VOICE_ENABLED, false);
  }

  public static void setVoiceEnabled(Context c, boolean on) {
    p(c).edit().putBoolean(VOICE_ENABLED, on).putBoolean(VOICE_ASKED, true).apply();
  }

  /** 처음 로그인했을 때 한 번은 상시 음성을 켜자고 묻는다 — 사용자가 끈 뒤로는 다시 켜지 않는다. */
  public static boolean voiceAsked(Context c) {
    return p(c).getBoolean(VOICE_ASKED, false);
  }
}
