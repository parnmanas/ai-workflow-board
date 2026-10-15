package com.parnmanas.awb;

import android.content.Context;
import android.os.Build;
import java.io.IOException;
import java.util.HashMap;
import java.util.Map;
import org.json.JSONObject;

/**
 * 세션 토큰의 단일 출처 — 화면(WebView)과 상시 음성 서비스가 같은 토큰을 쓴다.
 *
 * AWB 세션은 서버 메모리에만 있어 24시간 뒤나 서버 재시작(배포) 때 끊긴다. 앱은 로그인할 때
 * 단말 자격(`POST /api/auth/devices`)을 받아 두고, 끊기면 그것으로 새 세션을 받는다
 * (`POST /api/auth/devices/session`). 그래서 배포가 몇 번 지나가도 다시 로그인하지 않는다.
 *
 * 전부 동기 호출이다 — UI 스레드에서 부르지 말 것.
 */
public final class Auth {
  private static final long VALIDATE_EVERY_MS = 5 * 60_000L;
  private static final Object LOCK = new Object();
  private static long validatedAt = 0;

  private Auth() {}

  public static String base(Context c) {
    return Prefs.serverUrl(c);
  }

  public static Map<String, String> headers(String token) {
    Map<String, String> h = new HashMap<>();
    if (token != null && !token.isEmpty()) h.put("Authorization", "Bearer " + token);
    return h;
  }

  /** 지금 쓸 수 있는 세션 토큰. 없거나(로그인 전) 회수됐으면 "". 네트워크가 안 되면 가진 것을 준다. */
  public static String token(Context c) {
    synchronized (LOCK) {
      String token = Prefs.sessionToken(c);
      if (!token.isEmpty() && System.currentTimeMillis() - validatedAt < VALIDATE_EVERY_MS) return token;
      if (!token.isEmpty()) {
        try {
          Http.Response r = Http.getJson(base(c) + "/api/auth/me", headers(token));
          if (r.ok()) {
            validatedAt = System.currentTimeMillis();
            return token;
          }
          if (r.code != 401) return token;
        } catch (IOException e) {
          return token;
        }
      }
      return mintLocked(c);
    }
  }

  /** 401 을 받은 쪽이 부른다 — 단말 자격으로 새 세션을 받는다. 자격이 없거나 회수됐으면 "". */
  public static String refresh(Context c, String rejected) {
    synchronized (LOCK) {
      String current = Prefs.sessionToken(c);
      // 다른 스레드가 이미 새로 받았다.
      if (!current.isEmpty() && !current.equals(rejected)) return current;
      return mintLocked(c);
    }
  }

  private static String mintLocked(Context c) {
    String deviceToken = Prefs.deviceToken(c);
    if (deviceToken.isEmpty()) {
      Prefs.setSessionToken(c, "");
      return "";
    }
    try {
      Http.Response r = Http.postJson(base(c) + "/api/auth/devices/session", null,
          Http.obj("device_token", deviceToken, "app_version", BuildConfig.VERSION_NAME));
      if (r.ok()) {
        String token = r.json().optString("token", "");
        Prefs.setSessionToken(c, token);
        validatedAt = System.currentTimeMillis();
        return token;
      }
      if (r.code == 401) {
        // 회수됐다(다른 단말에서 지웠거나 사용자가 막혔다) — 다시 로그인해야 한다.
        Prefs.clearAuth(c);
      }
      return "";
    } catch (IOException e) {
      return Prefs.sessionToken(c);
    }
  }

  /**
   * 화면에서 로그인이 끝났다. 세션 토큰을 받아 두고, 이 사용자의 단말 자격이 없으면 받는다.
   * @return 단말 자격이 준비됐는가
   */
  public static boolean onLoggedIn(Context c, String token) throws IOException {
    if (token == null || token.isEmpty()) return false;
    Http.Response me = Http.getJson(base(c) + "/api/auth/me", headers(token));
    if (!me.ok()) return false;
    String userId = me.json().optString("id", "");
    synchronized (LOCK) {
      Prefs.setSessionToken(c, token);
      validatedAt = System.currentTimeMillis();
      if (!Prefs.deviceToken(c).isEmpty() && userId.equals(Prefs.deviceUserId(c))) return true;
      if (!Prefs.deviceToken(c).isEmpty()) revokeQuietly(c);
      Http.Response r = Http.postJson(base(c) + "/api/auth/devices", headers(token),
          Http.obj("name", deviceName(), "platform", "android", "app_version", BuildConfig.VERSION_NAME));
      if (!r.ok()) return false;
      JSONObject j = r.json();
      Prefs.setDevice(c, j.optString("device_id", ""), j.optString("device_token", ""), userId);
      return true;
    }
  }

  /** 화면에서 로그아웃했다 — 단말 자격을 회수하고 다 잊는다. */
  public static void onLoggedOut(Context c) {
    synchronized (LOCK) {
      revokeQuietly(c);
      Prefs.clearAuth(c);
      validatedAt = 0;
    }
  }

  private static void revokeQuietly(Context c) {
    String deviceToken = Prefs.deviceToken(c);
    if (deviceToken.isEmpty()) return;
    try {
      Http.postJson(base(c) + "/api/auth/devices/revoke", null, Http.obj("device_token", deviceToken));
    } catch (IOException ignored) {
      // 서버에 닿지 않아도 이 단말은 잊는다 — 서버 쪽 자격은 Settings 의 단말 목록에서 지울 수 있다.
    }
  }

  /** Custom Tab 구글 로그인의 마지막 단계 — `awb://oauth?code=` 의 코드를 세션 토큰으로 바꾼다. */
  public static String exchangeOAuthCode(Context c, String code, String verifier) throws IOException {
    Http.Response r = Http.postJson(base(c) + "/api/auth/oauth/app/exchange", null,
        Http.obj("code", code, "code_verifier", verifier));
    if (!r.ok()) throw new IOException(r.errorText());
    return r.json().optString("token", "");
  }

  public static String deviceName() {
    String maker = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER;
    String model = Build.MODEL == null ? "Android" : Build.MODEL;
    return model.toLowerCase().startsWith(maker.toLowerCase()) ? model : (maker + " " + model).trim();
  }
}
